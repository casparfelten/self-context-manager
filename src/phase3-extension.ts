import { mkdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { HarnessMessage, LlmMessage, ContentPart } from './context-manager.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import type { StoragePort, VersionRecord, VersionWriteInput } from './storage/storage-port.js';

type MetadataEntry = {
  id: string;
  type: 'file' | 'toolcall';
  status?: 'ok' | 'fail';
  path?: string | null;
  file_type?: string;
  char_count?: number;
  tool?: string;
  mtime_ms?: number;
};

type ObjectState = {
  id: string;
  type: 'file' | 'toolcall' | 'chat' | 'system_prompt';
  content: string | null;
  locked: boolean;
};

type Ref = {
  target_object_id: string;
  mode: 'dynamic' | 'pinned';
  target_version_id?: string;
  target_object_hash?: string;
  ref_kind: string;
  ref_metadata?: Record<string, unknown>;
};

type SessionContent = {
  chat_ref: Ref;
  system_prompt_ref?: Ref;
  active_set: Ref[];
  inactive_set: Ref[];
  pinned_set: Ref[];
};

type SessionMetadata = {
  metadata_pool?: MetadataEntry[];
};

type PinnedAnchor = {
  targetVersionId?: string;
  targetObjectHash?: string;
};

type SessionState = {
  activeIds: string[];
  pinned: Array<{ id: string; anchor: PinnedAnchor }>;
  metadataPool: MetadataEntry[];
};

type SessionRefScope = 'chat_ref' | 'system_prompt_ref' | 'active_set' | 'inactive_set' | 'pinned_set';

type SessionRefEntry = {
  scope: SessionRefScope;
  index: number;
  ref: Ref;
};

type ResolvedSessionRef = SessionRefEntry & {
  record: VersionRecord | null;
  unresolvedReason?: string;
};

type ResolvedActiveContent = {
  key: string;
  objectId: string;
  versionId: string;
  content: string;
  source: 'active_set' | 'pinned_set';
  mode: Ref['mode'];
  refKind: string;
};

// Legacy external backend support was intentionally removed.
// Any missing historical/as-of behavior must be reintroduced via StoragePort/SQLite,
// not by re-adding direct external backend clients.
/**
 * @impldoc SelfContextManager runtime
 *
 * `SelfContextManager` is the active runtime that bridges Pi session activity to
 * the versioned store.
 *
 * Current responsibilities:
 * - bootstrap/load session, chat, and system-prompt objects
 * - persist session transitions as immutable session versions
 * - maintain known-object metadata, active membership, and pinned membership
 * - assemble deterministic model context from storage-backed state
 * - observe tracked tool/file activity and sync it back through `StoragePort`
 * - watch tracked file paths for on-disk updates and unlinks
 *
 * Current assembly order:
 * 1. system prompt
 * 2. metadata block
 * 3. chat history + toolcall references
 * 4. active content blocks
 *
 * Important current limitation:
 * - explicit activate/deactivate/pin/unpin behavior exists here in the runtime,
 *   but the thin Pi wrapper does not yet expose a full model-facing control
 *   plane for deliberate self-context editing.
 */
export class SelfContextManager {
  private readonly storage: StoragePort;
  private readonly closeStorage?: () => void;

  private readonly objects = new Map<string, ObjectState>();
  private readonly metadataPool: MetadataEntry[] = [];
  private readonly metadataSeen = new Set<string>();
  private readonly activeSet = new Set<string>();
  private readonly pinnedSet = new Set<string>();
  private readonly pinnedAnchors = new Map<string, PinnedAnchor>();
  private readonly latestVersionByObject = new Map<string, string>();

  private readonly chatLog: HarnessMessage[] = [];
  private readonly watcher: FSWatcher;
  private readonly watchedPathToId = new Map<string, string>();
  private readonly recentUnlinks: Array<{ id: string; ts: number }> = [];

  private cursor = 0;
  private lastMessagesRef: HarnessMessage[] | null = null;
  private lastCursorSignature: string | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private persistError: Error | null = null;

  readonly sessionObjectId: string;
  readonly chatObjectId: string;
  readonly systemPromptObjectId: string;

  constructor(
    private readonly options: {
      sessionId: string;
      workspaceRoot?: string;
      systemPrompt?: string;
      storage?: StoragePort;
      storagePath?: string;
    },
  ) {
    this.storage = options.storage ?? this.createDefaultStorage(options);
    this.closeStorage = options.storage ? undefined : () => (this.storage as SqliteStorage).close();

    this.sessionObjectId = `session:${options.sessionId}`;
    this.chatObjectId = `chat:${options.sessionId}`;
    this.systemPromptObjectId = `system_prompt:${options.sessionId}`;

    this.objects.set(this.chatObjectId, { id: this.chatObjectId, type: 'chat', content: '', locked: true });
    this.objects.set(this.systemPromptObjectId, {
      id: this.systemPromptObjectId,
      type: 'system_prompt',
      content: options.systemPrompt ?? '',
      locked: true,
    });

    this.watcher = chokidar.watch([], { ignoreInitial: true, persistent: false });
    this.watcher.on('change', (path) => void this.handleWatcherUpsert(path));
    this.watcher.on('add', (path) => void this.handleWatcherUpsert(path));
    this.watcher.on('unlink', (path) => void this.handleWatcherUnlink(path));
  }

  /**
   * @impldoc Session bootstrap and resume
   *
   * `load()` initializes the runtime's durable baseline for the current
   * session. It ensures the system prompt and chat objects exist, restores prior
   * session state when present, rehydrates watched file paths, and then resumes
   * deterministic context assembly from the latest session HEAD.
   */
  async load(): Promise<void> {
    const existing = await this.readSessionState();

    await this.writeVersion({
      objectId: this.systemPromptObjectId,
      objectType: 'system_prompt',
      writerKind: 'system',
      writeReason: 'system',
      contentStruct: {
        content: this.options.systemPrompt ?? '',
      },
      metadata: {},
    });

    await this.writeVersion({
      objectId: this.chatObjectId,
      objectType: 'chat',
      writerKind: 'system',
      writeReason: 'system',
      contentStruct: {
        content: '',
        session_ref: this.makeDynamicRef(this.sessionObjectId, 'chat-session'),
        turn_count: this.chatLog.length,
      },
      metadata: {},
      sessionId: this.options.sessionId,
    });

    if (!existing) {
      this.activeSet.add(this.chatObjectId);
      await this.persistSessionState();
      return;
    }

    for (const entry of existing.metadataPool) {
      this.metadataSeen.add(entry.id);
      this.metadataPool.push(entry);
      if (entry.type === 'file' && entry.path) {
        this.watchedPathToId.set(entry.path, entry.id);
        await this.watcher.add(entry.path);
      }
    }

    for (const pinned of existing.pinned) {
      this.pinnedSet.add(pinned.id);
      this.pinnedAnchors.set(pinned.id, { ...pinned.anchor });
    }
    for (const id of existing.activeIds) this.activeSet.add(id);

    for (const id of this.activeSet) {
      if (id === this.chatObjectId || id === this.systemPromptObjectId) continue;
      const object = await this.fetchObjectState(id);
      if (object) this.objects.set(id, object);
    }

    await this.reconcileKnownFilesAfterResume();
  }

  async transformContext(messages: HarnessMessage[]): Promise<LlmMessage[]> {
    await this.consumeMessages(messages);
    await this.awaitPersist();
    return this.assembleContext();
  }

  /**
   * @impldoc Explicit file indexing
   *
   * `read(path)` is the runtime's explicit file-ingest path. It resolves the
   * workspace-relative path, indexes the file into the versioned store, marks it
   * active in the current session, and persists the resulting session change.
   *
   * Current missing-file behavior is structured rather than exceptional:
   * `ENOENT` becomes `{ ok: false, message }` so the caller can surface a clean
   * failure without tearing down the extension.
   */
  async read(path: string): Promise<{ ok: boolean; message: string; id?: string }> {
    const absolutePath = this.resolvePath(path);
    const id = `file:${absolutePath}`;

    try {
      await this.indexFileFromDisk(absolutePath, id, 'client', 'manual');
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code === 'ENOENT') return { ok: false, message: `read failed missing file path=${absolutePath}` };
      throw error;
    }

    this.activeSet.add(id);
    this.enqueuePersist();
    return { ok: true, message: `read ok id=${id}`, id };
  }

  /**
   * @impldoc Runtime context-set mutations
   *
   * The runtime already supports explicit context mutation over known objects:
   * - `activate` / `deactivate` change working-set membership
   * - `pin` / `unpin` manage durable anchors across context churn
   *
   * These operations persist through session versions, but they are currently a
   * runtime capability rather than a finished model-facing CLI/control surface.
   */
  activate(id: string): { ok: boolean; message: string } {
    const object = this.objects.get(id);
    if (!object) return { ok: false, message: `Object not found: ${id}` };
    if (object.content === null) return { ok: false, message: 'Content unavailable (non-text file)' };
    this.activeSet.add(id);
    this.enqueuePersist();
    return { ok: true, message: `activated ${id}` };
  }

  deactivate(id: string): { ok: boolean; message: string } {
    const object = this.objects.get(id);
    if (!object) return { ok: false, message: `Object not found: ${id}` };
    if (object.locked) return { ok: false, message: `Object is locked: ${id}` };
    this.activeSet.delete(id);
    this.enqueuePersist();
    return { ok: true, message: `deactivated ${id}` };
  }

  pin(id: string): { ok: boolean; message: string } {
    if (!this.knowsObject(id)) return { ok: false, message: `Object not found: ${id}` };
    this.pinnedSet.add(id);

    if (!this.pinnedAnchors.has(id)) {
      const cached = this.latestVersionByObject.get(id);
      if (cached) this.pinnedAnchors.set(id, { targetVersionId: cached });
    }

    this.enqueuePersist();
    return { ok: true, message: `pinned ${id}` };
  }

  unpin(id: string): { ok: boolean; message: string } {
    if (!this.knowsObject(id) && !this.pinnedSet.has(id)) return { ok: false, message: `Object not found: ${id}` };
    this.pinnedSet.delete(id);
    this.pinnedAnchors.delete(id);
    this.enqueuePersist();
    return { ok: true, message: `unpinned ${id}` };
  }

  async wrappedWrite(path: string, content: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await writeFile(absolutePath, content, 'utf8');
    await this.indexFileFromDisk(absolutePath, `file:${absolutePath}`, 'client', 'manual');
  }

  async wrappedEdit(path: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    await this.indexFileFromDisk(absolutePath, `file:${absolutePath}`, 'client', 'manual');
  }

  async wrappedLs(output: string): Promise<void> {
    await this.indexDiscoveredPaths(this.extractPathsFromList(output));
  }

  async wrappedFind(output: string): Promise<void> {
    await this.indexDiscoveredPaths(this.extractPathsFromList(output));
  }

  async wrappedGrep(output: string): Promise<void> {
    const paths = output
      .split('\n')
      .map((line) => line.split(':')[0]?.trim())
      .filter((line): line is string => Boolean(line));
    await this.indexDiscoveredPaths(paths);
  }

  /**
   * @impldoc Tool-observation heuristics
   *
   * `observeToolExecutionEnd()` is the current heuristic bridge from raw tool
   * execution back into managed context state. The active implementation only
   * reacts to `bash`, and then tries to infer candidate file paths from the
   * command/output pair.
   *
   * Current special case:
   * - multiline `ls <target>\n...` output is resolved relative to the ls target
   *   path so directory listings become metadata/file candidates under that
   *   target rather than under the workspace root.
   *
   * This is intentionally heuristic and narrower than a full tool-semantic
   * integration layer.
   */
  async observeToolExecutionEnd(toolName: string, commandOrOutput: string): Promise<void> {
    if (toolName !== 'bash') return;

    const lines = commandOrOutput.split('\n');
    const command = lines[0]?.trim() ?? '';
    const outputLines = lines.slice(1);

    if (outputLines.length > 0 && this.isLsCommand(command)) {
      const basePath = this.extractLsTargetPath(command);
      const inferred: string[] = [];

      for (const line of outputLines) {
        const mapped = this.mapLsOutputPath(basePath, line);
        if (mapped) inferred.push(mapped);
      }

      await this.indexDiscoveredPaths(inferred);
      return;
    }

    await this.indexDiscoveredPaths(this.extractBashPathTokens(commandOrOutput));
  }

  async getEntity(id: string): Promise<Record<string, unknown> | null> {
    const latest = await this.storage.getLatest(id);
    if (!latest) return null;

    this.latestVersionByObject.set(id, latest.versionId);
    return this.versionRecordToLegacyEntity(latest);
  }

  async getObjectHistory(id: string): Promise<Record<string, unknown>[]> {
    const history = await this.storage.getHistory(id, 'asc');
    for (const row of history) this.latestVersionByObject.set(id, row.versionId);
    return history.map((row) => this.versionRecordToLegacyEntity(row));
  }

  async close(): Promise<void> {
    await this.awaitPersist();
    await this.watcher.close();
    this.closeStorage?.();
  }

  getSnapshot() {
    return {
      metadataPool: [...this.metadataPool],
      activeSet: new Set(this.activeSet),
      pinnedSet: new Set(this.pinnedSet),
    };
  }

  private versionRecordToLegacyEntity(record: VersionRecord): Record<string, unknown> {
    const payload = asRecord(parseJson(record.contentStructJson), 'latest.contentStructJson');
    const metadata = asRecord(parseJson(record.metadataJson), 'latest.metadataJson');
    const type = inferObjectType(record.objectId);

    const entity: Record<string, unknown> = {
      id: record.objectId,
      type,
      ...payload,
      ...metadata,
    };

    if (record.path !== null) entity.path = record.path;
    if (record.sessionId !== null) entity.session_id = record.sessionId;
    if (record.toolName !== null) entity.tool_name = record.toolName;
    if (record.status !== null) entity.status = record.status;
    if (record.charCount !== null) entity.char_count = record.charCount;

    if (type === 'session') {
      entity.active_set = this.refIds(payload.active_set);
      entity.inactive_set = this.refIds(payload.inactive_set);
      entity.pinned_set = this.refIds(payload.pinned_set);
      if (Array.isArray(metadata.metadata_pool)) {
        entity.metadata_pool = metadata.metadata_pool;
      }
    }

    return entity;
  }

  private createDefaultStorage(options: { workspaceRoot?: string; storagePath?: string }): SqliteStorage {
    const root = options.workspaceRoot ?? resolve(tmpdir(), 'self-context-manager');
    const dbPath = options.storagePath ?? resolve(root, '.pi', 'self-context-manager.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    return new SqliteStorage({ path: dbPath });
  }

  private async consumeMessages(messages: HarnessMessage[]): Promise<void> {
    if (this.lastMessagesRef && messages !== this.lastMessagesRef) {
      const canContinue =
        this.cursor === 0 ||
        (messages.length >= this.cursor && this.lastCursorSignature === this.signature(messages[this.cursor - 1]));
      if (!canContinue) {
        this.cursor = messages.length;
        this.lastMessagesRef = messages;
        this.lastCursorSignature = this.cursor > 0 ? this.signature(messages[this.cursor - 1]) : null;
        return;
      }
    }

    if (messages.length < this.cursor) {
      this.cursor = messages.length;
      this.lastMessagesRef = messages;
      this.lastCursorSignature = this.cursor > 0 ? this.signature(messages[this.cursor - 1]) : null;
      return;
    }

    let mutated = false;

    for (const message of messages.slice(this.cursor)) {
      this.chatLog.push(message);
      if (message.role !== 'toolResult') continue;

      const content = this.extractText(message.content);
      const status = message.isError ? 'fail' : 'ok';

      await this.writeVersion({
        objectId: message.toolCallId,
        objectType: 'toolcall',
        writerKind: 'client',
        writeReason: 'manual',
        contentStruct: {
          content,
          tool: message.toolName,
          status,
          chat_ref: this.makeDynamicRef(this.chatObjectId, 'toolcall-chat'),
        },
        metadata: {},
        toolName: message.toolName,
        status,
      });

      this.objects.set(message.toolCallId, {
        id: message.toolCallId,
        type: 'toolcall',
        content,
        locked: false,
      });

      if (!this.metadataSeen.has(message.toolCallId)) {
        this.metadataSeen.add(message.toolCallId);
        this.metadataPool.push({
          id: message.toolCallId,
          type: 'toolcall',
          status,
          tool: message.toolName,
        });
      }

      this.activeSet.add(message.toolCallId);
      mutated = true;
    }

    this.cursor = messages.length;
    this.lastMessagesRef = messages;
    this.lastCursorSignature = this.cursor > 0 ? this.signature(messages[this.cursor - 1]) : null;

    if (mutated) this.enqueuePersist();
  }

  private async indexFileFromDisk(
    absolutePath: string,
    id: string,
    writerKind: VersionWriteInput['writerKind'],
    writeReason: VersionWriteInput['writeReason'],
  ): Promise<void> {
    const content = await readFile(absolutePath, 'utf8');
    const fileType = this.fileTypeFromPath(absolutePath);

    await this.writeVersion({
      objectId: id,
      objectType: 'file',
      writerKind,
      writeReason,
      contentStruct: {
        content,
        path: absolutePath,
        file_type: fileType,
        char_count: content.length,
      },
      metadata: {},
      path: absolutePath,
      charCount: content.length,
      fileBytes: new TextEncoder().encode(content),
    });

    this.objects.set(id, { id, type: 'file', content, locked: false });

    const fileStat = await stat(absolutePath);
    const existing = this.metadataPool.find((m) => m.id === id);
    if (existing) {
      existing.path = absolutePath;
      existing.file_type = fileType;
      existing.char_count = content.length;
      existing.mtime_ms = fileStat.mtimeMs;
    } else {
      this.metadataSeen.add(id);
      this.metadataPool.push({
        id,
        type: 'file',
        path: absolutePath,
        file_type: fileType,
        char_count: content.length,
        mtime_ms: fileStat.mtimeMs,
      });
    }

    this.watchedPathToId.set(absolutePath, id);
    await this.watcher.add(absolutePath);
    this.enqueuePersist();
  }

  private async indexDiscoveredPaths(paths: string[]): Promise<void> {
    for (const rawPath of paths) {
      const absolutePath = this.resolvePath(rawPath);
      const id = `file:${absolutePath}`;
      if (this.metadataSeen.has(id)) continue;

      const fileType = this.fileTypeFromPath(absolutePath);
      await this.writeVersion({
        objectId: id,
        objectType: 'file',
        writerKind: 'client',
        writeReason: 'manual',
        contentStruct: {
          content: null,
          path: absolutePath,
          file_type: fileType,
          char_count: 0,
        },
        metadata: {},
        path: absolutePath,
        charCount: 0,
      });

      this.objects.set(id, { id, type: 'file', content: null, locked: false });
      this.metadataSeen.add(id);
      this.metadataPool.push({
        id,
        type: 'file',
        path: absolutePath,
        file_type: fileType,
        char_count: 0,
      });
      this.watchedPathToId.set(absolutePath, id);
      await this.watcher.add(absolutePath);
    }

    this.enqueuePersist();
  }

  private async handleWatcherUpsert(path: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    let id = this.watchedPathToId.get(absolutePath);

    if (!id) {
      const candidate = this.recentUnlinks.find((u) => Date.now() - u.ts < 2_000);
      if (!candidate) return;
      id = candidate.id;
    }

    await this.indexFileFromDisk(absolutePath, id, 'watcher', 'watcher_sync');
  }

  private async handleWatcherUnlink(path: string): Promise<void> {
    const absolutePath = this.resolvePath(path);
    const id = this.watchedPathToId.get(absolutePath);
    if (!id) return;

    const existing = this.metadataPool.find((m) => m.id === id);
    const fileType = existing?.file_type ?? this.fileTypeFromPath(absolutePath);

    await this.writeVersion({
      objectId: id,
      objectType: 'file',
      writerKind: 'watcher',
      writeReason: 'watcher_sync',
      contentStruct: {
        content: null,
        path: null,
        file_type: fileType,
        char_count: 0,
      },
      metadata: {},
      path: null,
      charCount: 0,
      fileBytes: null,
    });

    if (existing) {
      existing.path = null;
      existing.char_count = 0;
      existing.mtime_ms = undefined;
    }

    this.objects.set(id, { id, type: 'file', content: null, locked: false });
    this.activeSet.delete(id);
    this.watchedPathToId.delete(absolutePath);
    this.recentUnlinks.push({ id, ts: Date.now() });
    while (this.recentUnlinks.length > 20) this.recentUnlinks.shift();

    this.enqueuePersist();
  }

  private async reconcileKnownFilesAfterResume(): Promise<void> {
    for (const entry of this.metadataPool) {
      if (entry.type !== 'file' || !entry.path) continue;

      try {
        const fileStat = await stat(entry.path);
        if (!entry.mtime_ms || fileStat.mtimeMs > entry.mtime_ms + 1) {
          await this.indexFileFromDisk(entry.path, entry.id, 'watcher', 'watcher_sync');
        }
      } catch {
        await this.handleWatcherUnlink(entry.path);
      }
    }
  }

  private enqueuePersist(): void {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.persistSessionState())
      .catch((error) => {
        this.persistError = asError(error);
      });
  }

  private async awaitPersist(): Promise<void> {
    await this.persistChain;
    if (!this.persistError) return;

    const error = this.persistError;
    this.persistError = null;
    throw error;
  }

  private async persistSessionState(): Promise<void> {
    const metadataIds = new Set(this.metadataPool.map((m) => m.id));
    const activeIds = [...this.activeSet].sort((a, b) => a.localeCompare(b));
    const inactiveIds = [...metadataIds].filter((id) => !this.activeSet.has(id)).sort((a, b) => a.localeCompare(b));

    const pinnedRefs: Ref[] = [];
    for (const id of [...this.pinnedSet].sort((a, b) => a.localeCompare(b))) {
      let anchor = this.pinnedAnchors.get(id);
      if (!anchor?.targetVersionId && !anchor?.targetObjectHash) {
        const versionId = await this.latestVersionId(id);
        if (!versionId) continue;
        anchor = { targetVersionId: versionId };
        this.pinnedAnchors.set(id, anchor);
      }

      const pinnedRef: Ref = {
        target_object_id: id,
        mode: 'pinned',
        ref_kind: 'session-pinned',
      };

      if (anchor.targetVersionId) pinnedRef.target_version_id = anchor.targetVersionId;
      if (anchor.targetObjectHash) pinnedRef.target_object_hash = anchor.targetObjectHash;
      pinnedRefs.push(pinnedRef);
    }

    const content: SessionContent = {
      chat_ref: this.makeDynamicRef(this.chatObjectId, 'session-chat-root'),
      system_prompt_ref: this.makeDynamicRef(this.systemPromptObjectId, 'session-system-root'),
      active_set: activeIds.map((id) => this.makeDynamicRef(id, 'session-active')),
      inactive_set: inactiveIds.map((id) => this.makeDynamicRef(id, 'session-inactive')),
      pinned_set: pinnedRefs,
    };

    await this.writeVersion({
      objectId: this.sessionObjectId,
      objectType: 'session',
      writerKind: 'system',
      writeReason: 'system',
      expectedCurrentVersionId: this.latestVersionByObject.get(this.sessionObjectId),
      contentStruct: content,
      metadata: {
        metadata_pool: this.sortMetadataEntries(this.metadataPool),
      },
      sessionId: this.options.sessionId,
    });
  }

  private async readSessionState(): Promise<SessionState | null> {
    const latest = await this.storage.getLatest(this.sessionObjectId);
    if (!latest) return null;

    this.latestVersionByObject.set(this.sessionObjectId, latest.versionId);

    const content = asRecord(parseJson(latest.contentStructJson), 'session.content_struct_json');
    const metadata = asRecord(parseJson(latest.metadataJson), 'session.metadata_json');

    const metadataPool = this.parseMetadataPool(metadata.metadata_pool ?? content.metadata_pool);

    return {
      activeIds: this.refIds(content.active_set),
      pinned: this.parsePinnedState(content.pinned_set),
      metadataPool,
    };
  }

  private parseMetadataPool(value: unknown): MetadataEntry[] {
    if (!Array.isArray(value)) return [];

    const entries: MetadataEntry[] = [];
    for (const raw of value) {
      if (!isRecord(raw)) continue;
      if (typeof raw.id !== 'string') continue;
      if (raw.type !== 'file' && raw.type !== 'toolcall') continue;

      entries.push({
        id: raw.id,
        type: raw.type,
        status: raw.status === 'ok' || raw.status === 'fail' ? raw.status : undefined,
        path: raw.path === null || typeof raw.path === 'string' ? raw.path : undefined,
        file_type: typeof raw.file_type === 'string' ? raw.file_type : undefined,
        char_count: Number.isInteger(raw.char_count) ? raw.char_count : undefined,
        tool: typeof raw.tool === 'string' ? raw.tool : undefined,
        mtime_ms: typeof raw.mtime_ms === 'number' ? raw.mtime_ms : undefined,
      });
    }

    return entries;
  }

  private refIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const ids: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        ids.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (typeof item.target_object_id === 'string') ids.push(item.target_object_id);
    }

    return ids;
  }

  private parsePinnedState(value: unknown): Array<{ id: string; anchor: PinnedAnchor }> {
    if (!Array.isArray(value)) return [];

    const pinned: Array<{ id: string; anchor: PinnedAnchor }> = [];
    for (const item of value) {
      if (typeof item === 'string') {
        pinned.push({ id: item, anchor: {} });
        continue;
      }
      if (!isRecord(item) || typeof item.target_object_id !== 'string') continue;

      const anchor: PinnedAnchor = {};
      if (typeof item.target_version_id === 'string') anchor.targetVersionId = item.target_version_id;
      if (typeof item.target_object_hash === 'string') anchor.targetObjectHash = item.target_object_hash;
      pinned.push({ id: item.target_object_id, anchor });
    }

    return pinned;
  }

  private async fetchObjectState(objectId: string): Promise<ObjectState | null> {
    const latest = await this.storage.getLatest(objectId);
    if (!latest) return null;

    this.latestVersionByObject.set(objectId, latest.versionId);

    const type = inferObjectType(objectId);
    if (type === 'session') return null;

    const payload = asRecord(parseJson(latest.contentStructJson), 'object.content_struct_json');
    const content = typeof payload.content === 'string' ? payload.content : null;

    return {
      id: objectId,
      type,
      content,
      locked: type === 'chat' || type === 'system_prompt',
    };
  }

  private async latestVersionId(objectId: string): Promise<string | null> {
    const cached = this.latestVersionByObject.get(objectId);
    if (cached) return cached;

    const latest = await this.storage.getLatest(objectId);
    if (!latest) return null;
    this.latestVersionByObject.set(objectId, latest.versionId);
    return latest.versionId;
  }

  private async writeVersion(input: Omit<VersionWriteInput, 'requestId' | 'writerId'> & { writerKind: VersionWriteInput['writerKind']; writeReason: VersionWriteInput['writeReason'] }): Promise<VersionRecord> {
    const result = await this.storage.putVersion({
      ...input,
      requestId: randomUUID(),
      writerId: 'self-context-manager',
    });

    if (result.ok === false) {
      if ('validation' in result) {
        throw new Error(`storage_validation:${result.reason}:${input.objectId}`);
      }
      throw new Error(`storage_conflict:${result.reason}:${input.objectId}`);
    }

    this.latestVersionByObject.set(input.objectId, result.record.versionId);
    return result.record;
  }

  private makeDynamicRef(targetObjectId: string, refKind: string): Ref {
    return {
      target_object_id: targetObjectId,
      mode: 'dynamic',
      ref_kind: refKind,
    };
  }

  private async assembleContext(): Promise<LlmMessage[]> {
    const resolved = await this.resolveSessionContext();

    const messages: LlmMessage[] = [{ role: 'system', content: resolved.systemPrompt }];
    messages.push({ role: 'user', content: this.renderMetadataPool(resolved.metadataPool, resolved.metadataRefLines) });
    messages.push(...this.renderChatHistoryBlock());

    for (const item of resolved.activeContent) {
      messages.push({
        role: 'user',
        content: `ACTIVE_CONTENT id=${item.objectId} source=${item.source} mode=${item.mode} version=${item.versionId}\n${item.content}`,
      });
    }

    return messages;
  }

  private renderChatHistoryBlock(): LlmMessage[] {
    const block: LlmMessage[] = [];

    for (const msg of this.chatLog) {
      if (msg.role === 'toolResult') {
        block.push({
          role: 'toolResult',
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          content: [{ type: 'text', text: `toolcall_ref id=${msg.toolCallId} tool=${msg.toolName} status=${msg.isError ? 'fail' : 'ok'}` }],
          isError: msg.isError,
          timestamp: msg.timestamp,
        });
        continue;
      }

      if (msg.role === 'assistant') {
        block.push(msg);
      } else {
        block.push({ role: 'user', content: this.extractText(msg.content) });
      }
    }

    return block;
  }

  private async resolveSessionContext(): Promise<{
    systemPrompt: string;
    metadataPool: MetadataEntry[];
    metadataRefLines: string[];
    activeContent: ResolvedActiveContent[];
  }> {
    const sessionLatest = await this.storage.getLatest(this.sessionObjectId);

    if (!sessionLatest) {
      return {
        systemPrompt: this.options.systemPrompt ?? '',
        metadataPool: this.sortMetadataEntries(this.metadataPool),
        metadataRefLines: [],
        activeContent: [],
      };
    }

    this.latestVersionByObject.set(this.sessionObjectId, sessionLatest.versionId);

    const content = asRecord(parseJson(sessionLatest.contentStructJson), 'session.content_struct_json');
    const metadata = asRecord(parseJson(sessionLatest.metadataJson), 'session.metadata_json');

    const metadataPool = this.parseMetadataPool(metadata.metadata_pool ?? content.metadata_pool);
    const sortedMetadata = this.sortMetadataEntries(metadataPool.length > 0 ? metadataPool : this.metadataPool);

    const refs: SessionRefEntry[] = [];

    const chatRef = this.parseSessionRef(content.chat_ref);
    if (chatRef) refs.push({ scope: 'chat_ref', index: 0, ref: chatRef });

    const systemPromptRef = this.parseSessionRef(content.system_prompt_ref);
    if (systemPromptRef) refs.push({ scope: 'system_prompt_ref', index: 0, ref: systemPromptRef });

    this.parseSessionRefArray(content.active_set).forEach((ref, index) => refs.push({ scope: 'active_set', index, ref }));
    this.parseSessionRefArray(content.inactive_set).forEach((ref, index) => refs.push({ scope: 'inactive_set', index, ref }));
    this.parseSessionRefArray(content.pinned_set).forEach((ref, index) => refs.push({ scope: 'pinned_set', index, ref }));

    const resolvedRefs = await this.resolveSessionRefs(refs);

    let systemPrompt = this.options.systemPrompt ?? '';
    const resolvedSystemPrompt = resolvedRefs.find((entry) => entry.scope === 'system_prompt_ref' && entry.record !== null);
    if (resolvedSystemPrompt?.record) {
      const contentText = this.contentFromVersion(resolvedSystemPrompt.record);
      if (contentText !== null) systemPrompt = contentText;
    }

    const metadataRefLines: string[] = [];

    for (const entry of [...resolvedRefs]
      .filter((ref) => ref.scope === 'inactive_set')
      .sort((a, b) => this.compareSessionRefResolution(a, b))) {
      metadataRefLines.push(
        `- inactive_ref id=${entry.ref.target_object_id} mode=${entry.ref.mode} anchor=${this.refAnchor(entry.ref)} resolved=${entry.record ? 'true' : 'false'}`,
      );
    }

    for (const entry of [...resolvedRefs]
      .filter((ref) => ref.record === null)
      .sort((a, b) => this.compareSessionRefResolution(a, b))) {
      metadataRefLines.push(
        `- unresolved_ref scope=${entry.scope} id=${entry.ref.target_object_id} mode=${entry.ref.mode} anchor=${this.refAnchor(entry.ref)} reason=${entry.unresolvedReason ?? 'unresolved'}`,
      );
    }

    const activeContent: ResolvedActiveContent[] = [];
    const seen = new Set<string>();

    for (const entry of resolvedRefs
      .filter((ref) => (ref.scope === 'active_set' || ref.scope === 'pinned_set') && ref.record !== null)
      .sort((a, b) => this.compareSessionRefResolution(a, b))) {
      if (!entry.record) continue;

      const contentText = this.contentFromVersion(entry.record);
      if (contentText === null) continue;

      const key = `${entry.record.objectId}:${entry.record.versionId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const source: ResolvedActiveContent['source'] = entry.scope === 'active_set' ? 'active_set' : 'pinned_set';

      activeContent.push({
        key,
        objectId: entry.record.objectId,
        versionId: entry.record.versionId,
        content: contentText,
        source,
        mode: entry.ref.mode,
        refKind: entry.ref.ref_kind,
      });
    }

    activeContent.sort((a, b) => this.compareActiveContent(a, b));

    return {
      systemPrompt,
      metadataPool: sortedMetadata,
      metadataRefLines,
      activeContent,
    };
  }

  private parseSessionRefArray(value: unknown): Ref[] {
    if (!Array.isArray(value)) return [];
    const refs: Ref[] = [];

    for (const raw of value) {
      const ref = this.parseSessionRef(raw);
      if (ref) refs.push(ref);
    }

    return refs;
  }

  private parseSessionRef(value: unknown): Ref | null {
    if (!isRecord(value)) return null;
    if (typeof value.target_object_id !== 'string') return null;
    if (value.mode !== 'dynamic' && value.mode !== 'pinned') return null;
    if (typeof value.ref_kind !== 'string') return null;

    const ref: Ref = {
      target_object_id: value.target_object_id,
      mode: value.mode,
      ref_kind: value.ref_kind,
    };

    if (typeof value.target_version_id === 'string') ref.target_version_id = value.target_version_id;
    if (typeof value.target_object_hash === 'string') ref.target_object_hash = value.target_object_hash;
    if (isRecord(value.ref_metadata)) ref.ref_metadata = value.ref_metadata;

    if (ref.mode === 'pinned' && !ref.target_version_id && !ref.target_object_hash) return null;
    return ref;
  }

  private async resolveSessionRefs(entries: SessionRefEntry[]): Promise<ResolvedSessionRef[]> {
    const latestCache = new Map<string, VersionRecord | null>();
    const historyCache = new Map<string, VersionRecord[]>();

    const resolved: ResolvedSessionRef[] = [];
    for (const entry of entries) {
      const outcome = await this.resolveRefRecord(entry.ref, latestCache, historyCache);
      resolved.push({
        ...entry,
        record: outcome.record,
        unresolvedReason: outcome.reason,
      });
    }

    return resolved;
  }

  private async resolveRefRecord(
    ref: Ref,
    latestCache: Map<string, VersionRecord | null>,
    historyCache: Map<string, VersionRecord[]>,
  ): Promise<{ record: VersionRecord | null; reason?: string }> {
    if (ref.mode === 'dynamic') {
      let latest = latestCache.get(ref.target_object_id);
      if (latest === undefined) {
        latest = await this.storage.getLatest(ref.target_object_id);
        latestCache.set(ref.target_object_id, latest);
      }

      if (!latest) return { record: null, reason: 'missing_target_head' };
      this.latestVersionByObject.set(latest.objectId, latest.versionId);
      return { record: latest };
    }

    let history = historyCache.get(ref.target_object_id);
    if (!history) {
      history = await this.storage.getHistory(ref.target_object_id, 'desc');
      historyCache.set(ref.target_object_id, history);
      if (history[0]) this.latestVersionByObject.set(history[0].objectId, history[0].versionId);
    }

    if (history.length === 0) return { record: null, reason: 'missing_target_object' };

    if (ref.target_version_id) {
      const byVersion = history.find((version) => version.versionId === ref.target_version_id);
      if (!byVersion) return { record: null, reason: 'missing_target_version' };
      if (ref.target_object_hash && byVersion.objectHash !== ref.target_object_hash) {
        return { record: null, reason: 'pinned_hash_mismatch' };
      }
      return { record: byVersion };
    }

    if (ref.target_object_hash) {
      const byHash = history.find((version) => version.objectHash === ref.target_object_hash);
      if (!byHash) return { record: null, reason: 'missing_target_hash' };
      return { record: byHash };
    }

    return { record: null, reason: 'invalid_pinned_anchor' };
  }

  private contentFromVersion(record: VersionRecord): string | null {
    try {
      const payload = asRecord(parseJson(record.contentStructJson), `content_struct:${record.versionId}`);
      return typeof payload.content === 'string' ? payload.content : null;
    } catch {
      return null;
    }
  }

  private refAnchor(ref: Ref): string {
    if (ref.target_version_id) return `version:${ref.target_version_id}`;
    if (ref.target_object_hash) return `hash:${ref.target_object_hash}`;
    return 'none';
  }

  private compareSessionRefResolution(left: SessionRefEntry, right: SessionRefEntry): number {
    const scopeRank: Record<SessionRefScope, number> = {
      chat_ref: 0,
      system_prompt_ref: 1,
      active_set: 2,
      inactive_set: 3,
      pinned_set: 4,
    };

    if (scopeRank[left.scope] !== scopeRank[right.scope]) {
      return scopeRank[left.scope] - scopeRank[right.scope];
    }

    if (left.ref.target_object_id !== right.ref.target_object_id) {
      return left.ref.target_object_id.localeCompare(right.ref.target_object_id);
    }

    const leftAnchor = this.refAnchor(left.ref);
    const rightAnchor = this.refAnchor(right.ref);
    if (leftAnchor !== rightAnchor) return leftAnchor.localeCompare(rightAnchor);

    if (left.ref.ref_kind !== right.ref.ref_kind) return left.ref.ref_kind.localeCompare(right.ref.ref_kind);
    return left.index - right.index;
  }

  private compareActiveContent(left: ResolvedActiveContent, right: ResolvedActiveContent): number {
    const sourceRank = (value: ResolvedActiveContent['source']) => (value === 'active_set' ? 0 : 1);

    if (sourceRank(left.source) !== sourceRank(right.source)) {
      return sourceRank(left.source) - sourceRank(right.source);
    }

    if (left.objectId !== right.objectId) return left.objectId.localeCompare(right.objectId);
    if (left.versionId !== right.versionId) return left.versionId.localeCompare(right.versionId);
    return left.refKind.localeCompare(right.refKind);
  }

  private sortMetadataEntries(entries: MetadataEntry[]): MetadataEntry[] {
    return [...entries].sort((left, right) => {
      if (left.id !== right.id) return left.id.localeCompare(right.id);
      if (left.type !== right.type) return left.type.localeCompare(right.type);
      const leftSuffix = left.type === 'file' ? left.path ?? '' : left.tool ?? '';
      const rightSuffix = right.type === 'file' ? right.path ?? '' : right.tool ?? '';
      return leftSuffix.localeCompare(rightSuffix);
    });
  }

  private renderMetadataPool(entries: MetadataEntry[], summaryLines: string[]): string {
    const lines = ['METADATA_POOL'];

    for (const entry of entries) {
      if (entry.type === 'toolcall') {
        lines.push(`- id=${entry.id} type=toolcall tool=${entry.tool} status=${entry.status}`);
      } else {
        lines.push(`- id=${entry.id} type=file path=${entry.path} file_type=${entry.file_type} char_count=${entry.char_count}`);
      }
    }

    if (summaryLines.length > 0) {
      lines.push('REF_SUMMARY');
      lines.push(...summaryLines);
    }

    return lines.join('\n');
  }

  private resolvePath(path: string): string {
    if (isAbsolute(path)) return path;
    return resolve(this.options.workspaceRoot ?? process.cwd(), path);
  }

  private fileTypeFromPath(path: string): string {
    const ext = extname(path).toLowerCase();
    if (!ext) return 'text';
    return ext.slice(1);
  }

  private extractBashPathTokens(value: string): string[] {
    const tokens = value
      .split(/\s+/)
      .map((token) => this.stripShellQuotes(token.trim()))
      .filter((token) => token.length > 0);

    return tokens.filter((token) => token.includes('/') || token.includes('.'));
  }

  private isLsCommand(command: string): boolean {
    const first = command.split(/\s+/).filter((token) => token.length > 0)[0];
    return first === 'ls';
  }

  private extractLsTargetPath(command: string): string | null {
    const tokens = command.split(/\s+/).map((token) => this.stripShellQuotes(token)).filter((token) => token.length > 0);
    if (tokens[0] !== 'ls') return null;

    const args: string[] = [];
    for (const token of tokens.slice(1)) {
      if (token === '&&' || token === '||' || token === '|' || token === ';') break;
      args.push(token);
    }

    const targets = args.filter((token) => !token.startsWith('-'));
    if (targets.length === 0) return null;
    return targets[targets.length - 1] ?? null;
  }

  private mapLsOutputPath(basePath: string | null, line: string): string | null {
    const output = line.trim();
    if (!output || output.startsWith('total ')) return null;
    if (!basePath) return output;
    if (isAbsolute(output)) return output;

    const normalizedBase = basePath.replace(/\/+$/, '');
    if (!normalizedBase) return output;

    if (output === basename(normalizedBase) || output === '.') return normalizedBase;
    return `${normalizedBase}/${output.replace(/^\.\//, '')}`;
  }

  private stripShellQuotes(token: string): string {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  }

  private extractPathsFromList(output: string): string[] {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private extractText(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  private signature(message: HarnessMessage): string {
    if (message.role === 'toolResult') return `tool:${message.toolCallId}:${message.timestamp}`;
    return `${message.role}:${message.timestamp}:${this.extractText(message.content)}`;
  }

  private knowsObject(id: string): boolean {
    return this.objects.has(id) || this.metadataSeen.has(id) || id === this.chatObjectId || id === this.systemPromptObjectId;
  }
}

function inferObjectType(objectId: string): ObjectState['type'] | 'session' {
  if (objectId.startsWith('file:')) return 'file';
  if (objectId.startsWith('chat:')) return 'chat';
  if (objectId.startsWith('session:')) return 'session';
  if (objectId.startsWith('system_prompt:')) return 'system_prompt';
  return 'toolcall';
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function asRecord(value: unknown, label: string): Record<string, any> {
  if (!isRecord(value)) {
    throw new Error(`expected_object:${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}
