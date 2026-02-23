# Implementation Plan

> What needs to change in the codebase to align with the SSOT (2026-02-23 revision).

This document lists concrete implementation tasks. Each references the SSOT section it implements. Ordered by dependency — earlier items unblock later ones.

---

## 1) Types — `src/types.ts`

**SSOT §2.2, §2.3, §2.5, §3.1**

The current types predate the object model. Rewrite to match the document structure defined in the SSOT.

### What changes

**Source binding types** (new):

```typescript
interface FilesystemSource {
  type: 'filesystem';
  filesystemId: string;
  path: string;
}

// Future source types will extend this union:
// interface S3Source { type: 's3'; bucket: string; key: string; }
// interface GitSource { type: 'git'; repo: string; ref: string; path: string; }

type Source = FilesystemSource; // | S3Source | GitSource
```

**Object envelope** (new — replaces ad-hoc fields):

```typescript
interface ObjectEnvelope {
  'xt/id': string;
  type: ObjectType;
  source: Source | null;
  identity_hash: string;
}
```

**Object types** (update existing):

- `FileObject`: add `source: FilesystemSource`, `source_hash: string`, `identity_hash: string`. Remove `id` as a user-set field — derive from identity hash. Keep `path`, `file_type`, `char_count` as mutable payload fields.
- `ToolcallObject`: add `source: null`, `identity_hash: string`. Keep existing fields.
- `ChatObject`: add `source: null`, `identity_hash: string`. Keep existing fields.
- `SessionObject`: add `session_index: string[]` (append-only). Rename/clarify `inactive_set` → distinguish session index from metadata pool.

**Session wrapper** (update `SessionObject`):

```typescript
interface SessionObject {
  'xt/id': string;
  type: 'session';
  source: null;
  identity_hash: string;
  session_id: string;
  chat_ref: string;
  system_prompt_ref: string;
  session_index: string[];    // append-only: every object ID ever encountered
  metadata_pool: string[];    // mutable: object IDs currently in metadata view
  active_set: string[];       // mutable: object IDs with content loaded
  pinned_set: string[];       // mutable: explicitly pinned object IDs
}
```

### Why

Current types mix concerns. `FileObject.id` is set by the caller as `file:{path}` — identity is ad-hoc. The new structure makes identity derivation explicit and separates the immutable envelope from the mutable payload. Adding the session index as a distinct field from the metadata pool implements the append-only guarantee.

---

## 2) Hashing — `src/hashing.ts`

**SSOT §2.2**

Currently has three hash functions that mix concerns. Replace with three clearly separated hashes.

### What changes

**`identityHash(type, source)`** — new. SHA-256 of the immutable envelope fields. For a filesystem file: `sha256(stableStringify({type: 'file', source: {type: 'filesystem', filesystemId: '...', path: '...'}}))`. Computed once at object creation. Used as the object ID for sourced objects.

**`sourceHash(rawBytes: Buffer)`** — new. SHA-256 of the raw external source bytes. For a file: hash of the file's contents as read from disk. This is NOT the same as `contentHash` — it hashes the raw source, not our document representation of it. Used for efficient change detection during indexing.

**`contentHash(mutablePayload: Record<string, unknown>)`** — updated. SHA-256 of all mutable payload fields via stable serialisation. Covers content, char_count, file_type, and any future fields. When we add fields, they're automatically included because we serialise the full mutable payload object.

**Remove:** `metadataViewHash` and `objectHash`. These served overlapping purposes that are now covered by the three distinct hashes.

### Why

The existing `contentHash` only hashes the content string, not the metadata fields. The existing `objectHash` hashes almost everything but excludes some fields by name — brittle when fields are added. The existing `metadataViewHash` is a hand-picked subset. The new scheme has clean separation: identity (immutable), source (external), content (document-level). Each has one clear purpose.

---

## 3) Filesystem identity

**SSOT §4.4**

New capability. The client needs to know what filesystem it's on.

### What to build

A function `getFilesystemId(): string` that returns a stable identifier for the current filesystem namespace.

Default implementation: read `/etc/machine-id`, SHA-256 it. Falls back to hostname hash if machine-id is unavailable.

This is called once at client startup and passed to the `SelfContextManager` constructor (or equivalent). All file source bindings use this filesystem ID.

### Why

Currently file IDs are `file:{absolutePath}`, which assumes a single filesystem. Two agents in different sandboxes reading `/workspace/main.ts` would collide. With filesystem ID, they get different object IDs because different source bindings.

---

## 4) Extension — `src/phase3-extension.ts`

**SSOT §2.4, §3.1, §4.5**

The main module. Multiple changes needed.

### What changes

**Constructor** — accept `filesystemId` (or compute it). Store it for use in all file source bindings.

**File identity** — change from `file:{path}` to `identityHash('file', {type: 'filesystem', filesystemId, path})`. The identity hash becomes the object ID.

**Session index** — add a `sessionIndex: Set<string>` alongside the existing `metadataPool`. When any object enters the metadata pool, also add its ID to the session index. The session index never has entries removed. Persist it in the session wrapper document.

**Indexing flow** — implement the protocol from SSOT §4.5:
1. Compute source binding from filesystem ID + absolute path.
2. Compute source hash from raw file bytes.
3. Derive object ID from identity hash.
4. Check database: new → create; unchanged hash → skip; changed hash → new version.

Currently the code always does `putAndWait` on every index operation. The source hash check eliminates unnecessary writes.

**Document structure** — when creating/updating file objects, include the full envelope (type, source, identity_hash) and the three hashes (identity_hash, source_hash, content_hash).

**Session persistence** — persist `session_index` array in the session wrapper document alongside metadata_pool, active_set, pinned_set.

**Session resume** — load session_index from persisted state. Reconcile tracked files using source hash comparison (current code does mtime comparison — replace with hash-based).

### Why

This is where the design meets the existing code. The extension currently works but uses ad-hoc identity, doesn't separate session index from metadata pool, and re-uploads content on every index. These changes align it with the SSOT without changing the external API (activate, deactivate, pin, read, etc.).

---

## 5) Context manager — `src/context-manager.ts`

**SSOT §5**

Smaller changes. This module handles context assembly and the in-memory pools.

### What changes

- Accept and manage file objects (currently toolcall-only in this module; files are handled separately in the extension).
- Render the session index / metadata pool distinction in context assembly if needed (for now, the agent sees the metadata pool, not the full session index — this is fine).
- No structural changes needed to the context assembly logic itself.

### Why

The extension and the context manager have overlapping responsibilities for pool management. The context manager should be the single authority on context assembly; the extension should handle indexing and source tracking. This is a cleanup, not a redesign. Can be deferred if needed.

---

## 6) Tests

**Existing tests will break** when types and hashing change. Update in the same commit.

### What changes

- `tests/phase1.test.ts` — update document construction to include source bindings and new hashes.
- `tests/phase2.test.ts` — minimal changes (context manager tests, mostly toolcall-focused).
- `tests/phase3.test.ts` — update file read/index tests for new identity scheme and source hashing.
- `tests/phase4.test.ts` — update watcher and session resume tests. Replace mtime-based checks with hash-based.
- `tests/e2e-final.test.ts` — update for new document structure.

New tests:
- Identity hash stability: same source → same ID, different filesystem → different ID.
- Source hash comparison: unchanged file → no new version, changed file → new version.
- Session index append-only: deactivated objects remain in session index.

---

## 7) Database handler

**SSOT §4.5**

Currently the XTDB client (`src/xtdb-client.ts`) is a thin HTTP wrapper. The indexing protocol (§4.5) needs a layer on top that handles the "check-then-write" logic.

### What to build

A database handler (could be a method on the extension, or a separate module) that implements the indexing protocol:

```
index(source: Source, sourceHash: string, content: string, metadata: {...})
  → { objectId: string, action: 'created' | 'updated' | 'unchanged' }
```

This encapsulates:
1. Derive object ID from source.
2. Fetch current version from XTDB.
3. Compare source hash.
4. Write new version if changed.
5. Return object ID and what happened.

The XTDB client itself stays unchanged — it's a transport layer.

### Why

The indexing logic is currently scattered across `indexFileFromDisk`, `handleWatcherUpsert`, and `reconcileKnownFilesAfterResume` in the extension. All three do variations of "read file, build document, put to XTDB." Centralising this in a handler eliminates duplication and makes the indexing protocol testable in isolation.

---

## Summary of changes by file

| File | Change scope |
|------|-------------|
| `src/types.ts` | Rewrite: source bindings, object envelope, session wrapper |
| `src/hashing.ts` | Rewrite: three clean hashes, remove legacy functions |
| `src/phase3-extension.ts` | Major update: filesystem ID, identity scheme, session index, indexing protocol |
| `src/context-manager.ts` | Minor update: accept file objects (can defer) |
| `src/xtdb-client.ts` | No changes |
| `src/index.ts` | Update exports if public API changes |
| `tests/*` | Update all suites for new types/hashing. Add new identity and indexing tests. |
| New: database handler | Indexing protocol implementation |
| New: filesystem ID utility | `getFilesystemId()` function |

---

## Migration notes

- Existing XTDB data uses the old document structure (no source bindings, old hash fields). A migration isn't strictly necessary for development — the test database can be wiped (it's experiment data). For any persistent data that matters, a migration script would read old documents and rewrite them with the new structure.
- The experiment scripts in `scripts/` will need updates to use the new API (filesystem ID in constructor, new document shapes).
