# Implementation Plan

> What needs to change in the codebase to align with the SSOT (2026-02-24 revision, content/infrastructure split). Each section references the SSOT section it implements. Ordered by dependency — earlier items unblock later ones.

---

## 1) Types — `src/types.ts`

**Implements: SSOT §2.1, §2.2, §2.3, §2.5, §3.1**

### Key change: content vs infrastructure

Object types are split into two categories:
- **Content objects** (`file`, `toolcall`) — participate in session index, metadata pool, active set. Agent can activate/deactivate.
- **Infrastructure objects** (`chat`, `system_prompt`, `session`) — stored in XTDB for persistence. Referenced by session wrapper. Rendered in fixed positions (system prompt at top, chat as conversation). NOT in session index, metadata pool, or active set.

The current code treats chat and system_prompt as objects with `locked: true` in the active set, then special-cases them in rendering. The new design removes them from the content management system entirely. Cleaner, no special cases.

### What changes

**Source binding types** (new):

```typescript
interface FilesystemSource {
  type: 'filesystem';
  filesystemId: string;
  path: string;  // canonical path (host-side for bind mounts)
}

type Source = FilesystemSource;  // extend union for future source types
```

**Object envelope** (new — replaces ad-hoc fields):

```typescript
type ObjectType = 'file' | 'toolcall' | 'chat' | 'system_prompt' | 'session';

interface ObjectEnvelope {
  'xt/id': string;
  type: ObjectType;
  source: Source | null;
  identity_hash: string;
}
```

**File object:**

```typescript
interface FileObject extends ObjectEnvelope {
  type: 'file';
  source: FilesystemSource;
  // mutable payload
  content: string | null;
  file_type: string;
  char_count: number;
  source_hash: string;
  content_hash: string;
}
```

No `id` field (use `xt/id`). No `path` in payload (use `source.path`). No `locked`, `provenance`, `nickname` fields.

**Toolcall object:**

```typescript
interface ToolcallObject extends ObjectEnvelope {
  type: 'toolcall';
  source: null;
  content: string;
  tool: string;
  args: Record<string, unknown>;
  args_display?: string;
  status: 'ok' | 'fail';
  chat_ref: string;
  file_refs?: string[];
  content_hash: string;
}
```

**Chat object:**

```typescript
interface ChatObject extends ObjectEnvelope {
  type: 'chat';
  source: null;
  content: string;
  turns: Turn[];
  session_ref: string;
  turn_count: number;
  toolcall_refs: string[];
  content_hash: string;
}
```

**Session object:**

```typescript
interface SessionObject extends ObjectEnvelope {
  type: 'session';
  source: null;
  session_id: string;
  chat_ref: string;
  system_prompt_ref: string;
  session_index: string[];   // append-only
  metadata_pool: string[];   // mutable, object IDs only
  active_set: string[];      // mutable
  pinned_set: string[];      // mutable
  content_hash: string;
}
```

**Removed fields:** `locked` (infrastructure objects are outside content management; no locking needed), `provenance` (captured by source binding or type-specific fields), `nickname` (not needed), `id` (use `xt/id`), `metadata_view_hash` and `object_hash` (replaced by new hash scheme).

**Metadata pool:** stores `string[]` of object IDs. The client looks up metadata (path, file_type, char_count, tool, status) from the database or in-memory cache. No duplication of mutable fields in the session document.

---

## 2) Hashing — `src/hashing.ts`

**Implements: SSOT §2.2**

### What changes

**`identityHash(type: string, source: Source | null): string`** — SHA-256 of `stableStringify({type, source})`. For sourced objects only. Used as `xt/id`.

**`sourceHash(content: string | Buffer): string`** — SHA-256 of raw source bytes. For files, this is the file content as read from disk. Accepts string or Buffer.

**`contentHash(mutablePayload: Record<string, unknown>): string`** — SHA-256 of all mutable payload fields via stable serialisation. Before hashing, removes `source_hash` and `content_hash` keys from the input object (clone, don't mutate). All other fields are included. Adding new mutable fields in the future automatically includes them.

**Removed:** `metadataViewHash`, `objectHash`, and the old `contentHash(content: string)`.

**`stableStringify`** is kept (already correct — deterministic key ordering, handles nested objects/arrays).

---

## 3) Filesystem resolver — new module `src/filesystem.ts`

**Implements: SSOT §5.2, §5.3, §5.4**

### What to build

```typescript
interface MountMapping {
  agentPrefix: string;      // e.g., "/workspace"
  canonicalPrefix: string;  // e.g., "/home/abaris/project"
  filesystemId: string;     // filesystem ID for this mount
}

interface ResolvedPath {
  filesystemId: string;
  canonicalPath: string;    // translated absolute path
}

class FilesystemResolver {
  constructor(
    private defaultFsId: string,
    private mounts: MountMapping[] = [],  // sorted by prefix length descending
  ) {}

  resolve(agentPath: string): ResolvedPath {
    // Longest-prefix match against mounts
    // If match: translate prefix, return mapping's filesystemId
    // If no match: return agentPath as-is with defaultFsId
  }
}
```

**`getDefaultFilesystemId(): Promise<string>`** — reads `/etc/machine-id`, returns SHA-256. Falls back to `os.hostname()` hash. Called once at startup.

**Device-ID detection (optional):** On `stat`, check `dev` field. Cache mapping from device ID to filesystem ID. If device differs from default and no mount mapping covers the path, generate a filesystem ID from the device ID. This is additive — mount mappings take precedence.

### Path resolution example

Agent reads `/workspace/src/main.ts`. Mount mapping: `{agentPrefix: "/workspace", canonicalPrefix: "/home/abaris/project", filesystemId: "abc..."}`.

Resolution: strip `/workspace`, prepend `/home/abaris/project` → canonical path `/home/abaris/project/src/main.ts`, filesystem ID `abc...`.

Source binding: `{type: "filesystem", filesystemId: "abc...", path: "/home/abaris/project/src/main.ts"}`.

A host agent reading `/home/abaris/project/src/main.ts` with no mount mapping: default filesystem ID is also `abc...` (same machine). Same source binding → same object.

### Watcher path

For bind-mounted files, the client watches the **canonical** (host-side) path, since the client runs on the host and that's the path it can access. For container-internal files (default filesystem ID, no mount mapping), the client does not set up a persistent watcher — these files are only indexed when the agent accesses them via tool calls.

### Reverse translation for display

The resolver also supports reverse translation: given a canonical path, return the agent-visible path. Used by the metadata rendering to show paths the agent recognises. Falls back to canonical path if no mapping matches (e.g., object created by a different client).

```typescript
reverseResolve(canonicalPath: string, filesystemId: string): string {
  // Find mount mapping where canonicalPrefix matches and filesystemId matches
  // Replace canonicalPrefix with agentPrefix
  // Fall back to canonicalPath if no match
}
```

---

## 4) Indexer — new module `src/indexer.ts`

**Implements: SSOT §5.6**

### What to build

```typescript
interface IndexResult {
  objectId: string;
  action: 'created' | 'updated' | 'unchanged';
}

async function indexFile(
  xtdb: XtdbClient,
  source: FilesystemSource,
  fileContent: string,
  fileType: string,
): Promise<IndexResult> {
  const objectId = identityHash('file', source);
  const srcHash = sourceHash(fileContent);

  const existing = await xtdb.get(objectId);

  if (!existing) {
    // Create new object
    const doc = buildFileDocument(objectId, source, fileContent, fileType, srcHash);
    await xtdb.putAndWait(doc);
    return { objectId, action: 'created' };
  }

  if (existing.source_hash === srcHash) {
    return { objectId, action: 'unchanged' };
  }

  // Update: new version
  const doc = buildFileDocument(objectId, source, fileContent, fileType, srcHash);
  await xtdb.putAndWait(doc);
  return { objectId, action: 'updated' };
}
```

`buildFileDocument` constructs the full document with immutable envelope + mutable payload + all three hashes.

Also: `indexFileDeletion(xtdb, source)` — writes a version with null content, char_count 0. Called on confirmed deletion (watcher unlink event).

**Why a separate module:** indexing logic is currently scattered across `indexFileFromDisk`, `handleWatcherUpsert`, and `reconcileKnownFilesAfterResume` in the extension. All three are variations of read-file-then-write. Centralising makes the protocol testable in isolation and ensures consistency.

---

## 5) Extension — `src/phase3-extension.ts`

**Implements: SSOT §2.1, §3, §5.1, §5.6, §5.7, §5.8**

External API (activate, deactivate, pin, read, wrappedWrite, etc.) stays the same. Internal changes:

### Constructor

Accept: `sessionId`, `xtdbBaseUrl`, `filesystemResolver: FilesystemResolver`, optional `systemPrompt`.

The `FilesystemResolver` encapsulates all filesystem-awareness logic. The extension doesn't do path translation or filesystem ID generation itself.

### File identity

Replace `file:${path}` with `identityHash('file', resolver.resolve(path))`. All file references go through the resolver.

### Content/infrastructure split

Chat and system_prompt objects are created and updated by the client but NOT added to the session index, metadata pool, or active set. They're referenced by `chat_ref` and `system_prompt_ref` on the session document. The `objects` map in memory should distinguish between content objects (available for activate/deactivate) and infrastructure objects (managed internally).

The `assembleContext` method renders infrastructure objects in their fixed positions (system prompt first, chat as conversation) and content objects in the metadata/active sections. No special-casing of "locked" objects.

### Session index

New `sessionIndex: Set<string>`. Content objects only. Any time a content object is encountered (indexed, discovered, loaded on resume), add its ID. Never remove. Persisted as `session_index` in the session wrapper.

### Metadata pool

Change from `MetadataEntry[]` to `Set<string>` of object IDs. The client maintains an in-memory cache `Map<string, MetadataCache>` for rendering, populated on index and resume:

```typescript
interface MetadataCache {
  type: 'file' | 'toolcall';  // content objects only
  // file-specific
  displayPath?: string;  // agent-visible path (reverse-translated)
  file_type?: string;
  char_count?: number;
  // toolcall-specific
  tool?: string;
  status?: string;
}
```

### Indexing

Replace all `putAndWait` calls for file objects with `indexFile()` from the indexer module. Content comes from:
- Tool output (read, write, edit — content is already available from the tool call).
- Watcher events (client reads the file directly at the canonical path).
- Resume reconciliation (client reads each sourced file's canonical path).

### Watcher setup

When a file is indexed, set up a watcher on the **canonical** path (from the resolver) only if the canonical path is on a filesystem the client can directly access. For bind-mounted files: watch the host path. For container-internal files: skip the watcher.

Decision: track watchability via the resolver. If the resolved path came from a mount mapping (the canonical prefix is a host path the client can access), it's watchable. If it used the default filesystem ID (container-internal), it's not. The resolver can expose this: `resolver.isWatchable(agentPath): boolean`.

### Session persistence

Session document includes: `session_index`, `metadata_pool`, `active_set`, `pinned_set` (all `string[]`).

### Session resume

1. Fetch session document from XTDB.
2. Restore sets: session index, metadata pool, active set, pinned set.
3. Fetch all objects in session index (batch Datalog query by IDs).
4. Populate metadata cache from fetched objects.
5. For each sourced object: if source is accessible, run indexing protocol. If not accessible, mark as orphaned (no action — latest version remains).
6. Populate active content cache for objects in active set.
7. Re-establish watchers for watchable sourced objects.

---

## 6) Context manager — `src/context-manager.ts`

**Implements: SSOT §4**

### Decision: defer

The extension currently handles context assembly for files. The context manager handles tool calls. Merging them is a cleanup — both are working, the external behaviour doesn't change. Defer until the object model and indexing protocol are solid.

No changes in this round.

---

## 7) Tests

**Existing tests will break.** Update alongside code changes.

### Updates to existing tests

- `phase1.test.ts` — update document construction (source bindings, new hashes, no `locked`/`provenance`/`nickname`).
- `phase2.test.ts` — minimal (context manager, toolcall-focused, largely unchanged).
- `phase3.test.ts` — update file operations for source-derived identity, indexer module, resolver. Verify chat/system_prompt are not in session index or metadata pool.
- `phase4.test.ts` — update watcher/resume for canonical paths, hash-based reconciliation (replace mtime).
- `e2e-final.test.ts` — update for new document structure. Verify content/infrastructure split in rendered context.

### New tests

- **Content/infrastructure split:** chat and system_prompt not in session index. Not in metadata pool. Not in active set. Rendered in fixed positions. Tool calls and files ARE in session index.
- **Identity hash:** same source → same ID. Different filesystem ID → different ID. Same path string, different filesystem → different object.
- **Source hash indexing:** unchanged file → `unchanged` (no write). Changed file → `updated` (new version). Verify via XTDB history.
- **Session index:** append-only guarantee. Deactivated objects remain. Deleted files remain (null-content latest version).
- **Filesystem resolver:** prefix matching, path translation, reverse translation, default fallback, longest-match precedence.
- **Path display:** metadata rendering shows agent-visible path (reverse-translated), not canonical path. Non-sandboxed: paths are identical. Sandboxed: agent prefix shown.
- **Watchability:** bind-mounted paths are watchable, container-internal paths are not.
- **Indexer:** new → created, unchanged → no-op, changed → updated, deletion → null content. All against real XTDB.

---

## 8) Cleanup

### Remove stale fields from codebase

When updating types: remove all references to `locked`, `provenance`, `nickname`, `id` (in favour of `xt/id`), `metadata_view_hash`, `object_hash`, `mtime_ms`. Remove any code that adds chat/system_prompt objects to the active set, metadata pool, or session index.

### Update references

- `AGENTS.md` — verify "XTDB dependency" section.
- Experiment scripts in `scripts/` — update constructor calls (filesystem resolver, new session structure). Can be done after core implementation.

---

## Dependency order

```
1. types.ts           (no deps — pure type definitions)
2. hashing.ts         (depends on types for Source)
3. filesystem.ts      (no deps — utility module)
4. indexer.ts          (depends on types, hashing, xtdb-client)
5. phase3-extension.ts (depends on all above)
6. tests               (updated alongside each module)
7. context-manager.ts  (deferred)
8. cleanup             (after everything works)
```

---

## Migration

Existing XTDB data uses the old document structure. The test/experiment database can be wiped — it's experiment data. For persistent data: a migration script would read old documents and rewrite with the new envelope + payload structure. Not needed for development.
