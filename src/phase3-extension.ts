import { mkdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
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

type SessionState = {
  activeIds: string[];
  pinnedIds: string[];
  metadataPool: MetadataEntry[];
};

// Legacy external backend support was intentionally removed.
// Any missing historical/as-of behavior must be reintroduced via StoragePort/SQLite,
// not by re-adding direct external backend clients.
export class SelfContextManager {
  private readonly storage: StoragePort;
  private readonly closeStorage?: () => void;

  private readonly objects = new Map<string, ObjectState>();
  private readonly metadataPool: MetadataEntry[] = [];
  private readonly metadataSeen = new Set<string>();
  private readonly activeSet = new Set<string>();
  private readonly pinnedSet = new Set<string>();
  private readonly latestVersionByObject = new Map<string, string>();

  private readonly chatLog: HarnessMessage[] = [];
  private readonly watcher: FSWatcher;
  private readonly watchedPathToId = new Map<string, string>();
  private readonly recentUnlinks: Array<{ id: string; ts: number }> = [];

  private cursor = 0;
  private lastMessagesRef: HarnessMessage[] | null = null;
  private lastCursorSignature: string | null = null;
  private persistChain: Promise<void> = Promise.resolve();

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

    for (const id of existing.pinnedIds) this.pinnedSet.add(id);
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
    return this.assembleContext();
  }

  async read(path: string): Promise<{ ok: boolean; message: string; id?: string }> {
    const absolutePath = this.resolvePath(path);
    const id = `file:${absolutePath}`;
    await this.indexFileFromDisk(absolutePath, id, 'client', 'manual');
    this.activeSet.add(id);
    this.enqueuePersist();
    return { ok: true, message: `read ok id=${id}`, id };
  }

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
    this.enqueuePersist();
    return { ok: true, message: `pinned ${id}` };
  }

  unpin(id: string): { ok: boolean; message: string } {
    if (!this.knowsObject(id) && !this.pinnedSet.has(id)) return { ok: false, message: `Object not found: ${id}` };
    this.pinnedSet.delete(id);
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

  async observeToolExecutionEnd(toolName: string, commandOrOutput: string): Promise<void> {
    if (toolName !== 'bash') return;
    const tokens = commandOrOutput.split(/\s+/).filter(Boolean);
    const guessed = tokens.filter((t) => t.includes('/') || t.includes('.'));
    await this.indexDiscoveredPaths(guessed);
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
    await this.persistChain;
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
    }

    this.cursor = messages.length;
    this.lastMessagesRef = messages;
    this.lastCursorSignature = this.cursor > 0 ? this.signature(messages[this.cursor - 1]) : null;
    this.enqueuePersist();
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
    this.persistChain = this.persistChain.then(() => this.persistSessionState()).catch(() => undefined);
  }

  private async persistSessionState(): Promise<void> {
    const metadataIds = new Set(this.metadataPool.map((m) => m.id));
    const inactiveIds = [...metadataIds].filter((id) => !this.activeSet.has(id));

    const pinnedRefs: Ref[] = [];
    for (const id of this.pinnedSet) {
      const versionId = await this.latestVersionId(id);
      if (!versionId) continue;
      pinnedRefs.push({
        target_object_id: id,
        mode: 'pinned',
        target_version_id: versionId,
        ref_kind: 'session-pinned',
      });
    }

    const content: SessionContent = {
      chat_ref: this.makeDynamicRef(this.chatObjectId, 'session-chat-root'),
      system_prompt_ref: this.makeDynamicRef(this.systemPromptObjectId, 'session-system-root'),
      active_set: [...this.activeSet].map((id) => this.makeDynamicRef(id, 'session-active')),
      inactive_set: inactiveIds.map((id) => this.makeDynamicRef(id, 'session-inactive')),
      pinned_set: pinnedRefs,
    };

    await this.writeVersion({
      objectId: this.sessionObjectId,
      objectType: 'session',
      writerKind: 'system',
      writeReason: 'system',
      contentStruct: content,
      metadata: {
        metadata_pool: this.metadataPool,
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
      pinnedIds: this.refIds(content.pinned_set),
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

  private assembleContext(): LlmMessage[] {
    const messages: LlmMessage[] = [{ role: 'system', content: this.options.systemPrompt ?? '' }];
    messages.push({ role: 'user', content: this.renderMetadataPool() });

    for (const msg of this.chatLog) {
      if (msg.role === 'toolResult') {
        messages.push({
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
        messages.push(msg);
      } else {
        messages.push({ role: 'user', content: this.extractText(msg.content) });
      }
    }

    for (const id of this.activeSet) {
      if (id === this.chatObjectId || id === this.systemPromptObjectId) continue;
      const object = this.objects.get(id);
      if (!object || object.content === null) continue;
      messages.push({ role: 'user', content: `ACTIVE_CONTENT id=${id}\n${object.content}` });
    }

    return messages;
  }

  private renderMetadataPool(): string {
    const lines = ['METADATA_POOL'];
    for (const entry of this.metadataPool) {
      if (entry.type === 'toolcall') {
        lines.push(`- id=${entry.id} type=toolcall tool=${entry.tool} status=${entry.status}`);
      } else {
        lines.push(`- id=${entry.id} type=file path=${entry.path} file_type=${entry.file_type} char_count=${entry.char_count}`);
      }
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
