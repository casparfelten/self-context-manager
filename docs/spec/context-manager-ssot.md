# Context Manager SSOT (Single Source of Truth)

> **Authoritative document.** This is the canonical specification for the project's design, data model, and implementation status. If any other document conflicts with this one, this SSOT wins until explicitly updated.

---

## 1) Fundamentals

### 1.1 Problem

LLM agents lose continuity in long tasks because context windows are limited and tool outputs/files are repeatedly re-injected as raw text. This causes context bloat, drift, and inconsistent behaviour across turns.

### 1.2 Goals

- Provide a **context manager layer** — not just a memory bucket, but active control over what an LLM sees each turn.
- Let agents operate over **objects and references** instead of repeated full-text re-reading.
- Keep context controllable through explicit **activation and deactivation**.
- Preserve reproducibility with version-aware references and durable history.
- Support **multiple agents** sharing a database without interference, and **portable sessions** that can be paused, moved, and resumed.

### 1.3 Principles

- **Separation of concerns.** The host harness runs the agent loop, tools, and UI. This layer controls the LLM-visible context.
- **Metadata first.** Inactive objects remain visible via compact metadata summaries. The agent browses metadata broadly and activates narrowly.
- **Explicit context logistics.** Active content is a deliberate subset, not everything ever seen.
- **Store rich, render adapted.** Preserve structured internal state; adapt at the model/harness boundary.
- **Append-only history.** Objects accumulate versions. Deletions and orphaning create new versions (null content, tombstone state). History is never erased.

### 1.4 Invariants

- Objects have stable identity and version history.
- Chat history remains present as canonical conversation state.
- Tool result payloads are separate from chat inline metadata references.
- Active/inactive transitions change what content is loaded, not object identity.
- Session index is append-only. Objects are never removed from a session's index once encountered.

---

## 2) Data Model

### 2.1 Objects

An **object** is a versioned entity in the database. Every object has a stable ID, a type, and a version history. XTDB's bi-temporal store provides the versioning: every write creates a new version; the full history is queryable.

Objects come in two kinds:

**Sourced objects** are bound to an external thing — a file on a filesystem, an S3 object (future), a git blob (future). The source binding defines what the object tracks and is part of its permanent identity.

**Unsourced objects** exist only in the database. Tool call results, chat records, session state. No external source to watch.

### 2.2 Object document structure

Every object document stored in XTDB has two zones:

**Immutable envelope** — set at creation, never changes across versions:

| Field | Description |
|-------|-------------|
| `xt/id` | Object ID. For sourced objects, derived from identity hash. For unsourced, assigned at creation. |
| `type` | Object type: `file`, `toolcall`, `chat`, `system_prompt`, `session`. |
| `source` | Source binding. `null` for unsourced objects. Tagged union by source type (see §2.3). |
| `identity_hash` | SHA-256 of the immutable envelope fields (type + source). Verifies identity consistency. |

**Mutable payload** — creates a new version when changed:

| Field | Description |
|-------|-------------|
| `content` | The payload. String or null (null for deleted/orphaned/non-text). |
| `source_hash` | SHA-256 of the raw external source (e.g., file bytes on disk). Only for sourced objects. Used for change detection during indexing. |
| `content_hash` | SHA-256 of all mutable payload fields (content + operational metadata). Detects document-level changes. |
| *(type-specific fields)* | Additional fields depending on object type — `char_count`, `file_type`, `path`, `tool`, `args`, `status`, etc. |

**Why three hashes:**

- **`identity_hash`** answers: is this the same object? Computed once. Derived from immutable fields only. Immune to schema additions.
- **`source_hash`** answers: has the external source changed since last index? For a file, this is SHA-256 of the raw bytes on disk — not of our document. Used by the indexing protocol to avoid uploading unchanged content.
- **`content_hash`** answers: has the document payload changed? Covers all mutable fields via stable serialisation. When we add new mutable fields in the future, they get included. This is the database-level change indicator.

### 2.3 Source bindings

The `source` field is a tagged union. The `type` field determines the schema of the source-specific fields nested within it.

**Filesystem source** (current):

```
{
  "type": "filesystem",
  "filesystemId": "...",   // identifies the filesystem namespace
  "path": "..."            // absolute path within that filesystem
}
```

**Future source types** (not yet implemented):

```
{ "type": "s3", "bucket": "...", "key": "..." }
{ "type": "git", "repo": "...", "ref": "...", "path": "..." }
```

The source type determines:
- How the source hash is computed (file bytes for filesystem, etag for S3, blob hash for git).
- What tracking infrastructure applies (file watcher, S3 poller, webhook listener).
- What fields are needed in the source locator.

New source types extend the union. Existing source types are stable once defined.

### 2.4 Object identity

For **sourced objects**, identity is derived from the source binding: `SHA-256(type + source)`. Two clients indexing the same source (same filesystem, same path) get the same identity hash and therefore the same object ID. This is how multi-agent access to the same file resolves to a single versioned object.

For **unsourced objects**, identity is assigned at creation. Tool calls use their call ID. Chat objects use `chat:{sessionId}`. Session objects use `session:{sessionId}`.

**The identity rule:** if agent A changes it and agent B inherently sees the change (same file on the same filesystem, same S3 object, etc.), it is the same object. If they are on different filesystems such that changes don't propagate, they are different objects with different IDs, even if the path string is identical.

### 2.5 Object types

| Type | Sourced | Description |
|------|---------|-------------|
| `file` | Yes (filesystem) | A file on disk. Content is the file's text. Tracked by filesystem watcher. |
| `toolcall` | No | Result of a tool execution. Content is the tool output. Created inline during conversation. |
| `chat` | No | A session's conversation history. Locked (cannot be deactivated). One per session. |
| `system_prompt` | No | A session's system prompt. Locked. One per session. |
| `session` | No | Session wrapper object (see §3). Contains all session state. |

---

## 3) Sessions

A **session** is one agent's complete interaction state. It is the portable unit — everything needed to pause, move, and resume an agent's work.

### 3.1 Session structure

The session wrapper object contains:

| Field | Mutability | Description |
|-------|-----------|-------------|
| Session ID | Immutable | Stable identifier for this session. |
| Chat reference | Immutable | ID of this session's chat object. |
| System prompt reference | Immutable | ID of this session's system prompt object. |
| **Session index** | Append-only | Set of every object ID this session has ever encountered. Never shrinks. If an object is deleted or orphaned, it stays in the index — the object's latest version reflects the loss, but the index entry remains. |
| **Metadata pool** | Mutable | Subset of the session index. Objects currently loaded as compact metadata in the agent's context window. |
| **Active set** | Mutable | Subset of the metadata pool. Objects whose full content is loaded in context. |
| **Pinned set** | Mutable | Objects the agent has explicitly pinned. Policy-dependent (e.g., pinned objects are not auto-deactivated). |

### 3.2 Context levels

From the agent's perspective, an object can be in one of three states:

1. **Active** — full content loaded in context. Costs tokens.
2. **Inactive (metadata)** — compact metadata summary visible. Agent can browse and activate.
3. **Indexed only** — in the session index but not in the metadata pool. The agent doesn't see it in context, but the session remembers it exists. Can be promoted to metadata pool.

### 3.3 Activation and deactivation

- `activate(id)` — load object content into the active set. Object must be in the session index.
- `deactivate(id)` — remove from active set, keep in metadata pool.
- Locked objects (chat, system prompt) cannot be deactivated.
- Recent tool call outputs are auto-activated; older outputs auto-collapse based on a sliding window policy.

### 3.4 What the agent controls

- Metadata pool membership (which indexed objects appear as metadata in context).
- Active set membership (which objects have full content loaded).
- Pinned set membership.
- Triggering new object creation (by reading files, running tools).

### 3.5 What the agent does not control

- Session index (append-only — agent cannot remove entries).
- Object version history (cannot rewrite or delete versions).
- Object identity and immutable envelope (set at creation).
- Other sessions' state.

### 3.6 Session lifecycle

- **Active** — agent is running. Session state is updated each turn.
- **Paused** — agent is not running. Session state is persisted in the database. All references remain valid.
- **Resumed** — session is loaded from database. Tracked objects are checked against their sources (re-hashed, re-versioned if changed). Orphaned objects are detected. Active/metadata/pinned sets are restored.

### 3.7 Multi-session databases

Multiple sessions can exist in the same database. Sessions are isolated by design: each has its own index, metadata pool, active set, chat, and system prompt. Objects are shared across sessions — two sessions activating the same file reference the same object and see the same version history. This is correct: the object represents the file, not the session's view of it.

Concurrent access from multiple agents is supported. The database handles concurrent HTTP requests. Sessions are separated at the application level by session ID, not by database isolation.

---

## 4) Sources and Tracking

### 4.1 Sources

A **source** is the external thing a sourced object is bound to. Defined by the source binding in the object's immutable envelope (§2.3).

The source determines identity. Two objects with the same source are the same object. The source binding is immutable — once an object is created with a source, that binding never changes.

### 4.2 Trackers

A **tracker** is a process that watches a source and pushes updates to the database when the source changes. For filesystem sources, this is a file watcher. Different source types would use different tracking mechanisms.

Trackers are run by clients. A client is an agent process (or harness) connected to the database. Each client runs trackers for the sources it has access to. Multiple clients can track the same source — any of them can push updates, and all updates resolve to the same object.

### 4.3 Tracker lifecycle

- **Attached** — a tracker is actively watching the source and will push updates on change.
- **Orphaned** — no tracker is active. The object's latest version reflects the last known state. Common causes: sandbox destroyed, machine offline, file deleted. Orphaning is normal and expected, not an error condition.
- **Resumed** — a tracker re-attaches to an orphaned object. Checks current source state, creates a new version if changed.

When a source is confirmed deleted (not just unreachable), the latest version is updated with null content. The object and its history remain in the database.

### 4.4 Filesystem identity

A **filesystem ID** identifies a distinct filesystem namespace. Two paths on the same filesystem ID refer to the same underlying files. Two paths on different filesystem IDs are independent even if the path strings match.

The client generates its filesystem ID programmatically at startup. Default mechanism: SHA-256 of `/etc/machine-id` (or platform equivalent). In a Docker container, the container has its own machine-id, so sandbox agents automatically get a different filesystem ID from host agents.

For bind-mounted directories where a sandbox and host share the same files, the harness is responsible for ensuring both sides declare the same filesystem ID for that mount. The database trusts declared filesystem IDs — clients are assumed trusted.

### 4.5 Indexing protocol

When a client encounters a file:

1. Client computes the source locator: `{type: "filesystem", filesystemId: X, path: Y}`.
2. Client computes the source hash: SHA-256 of the raw file bytes on disk.
3. Client resolves identity: derives the object ID from the source binding.
4. Client checks against the database:
   - **New source** (object ID not in database): create new object. Store first version with full content. Return object ID.
   - **Known source, source hash unchanged**: no-op. Return object ID.
   - **Known source, source hash changed**: upload full content. Write new version with updated source hash, content, content hash, and operational metadata. Return object ID.

The common case (file hasn't changed) requires one hash computation and one database lookup. No content upload, no write.

---

## 5) Context Assembly

### 5.1 Context rendering

Each turn, the context manager assembles the LLM-visible context from the session state:

1. System prompt.
2. Metadata pool rendered as compact summaries.
3. Chat history (user messages, assistant messages, tool call metadata references).
4. Active content blocks (full content of active objects).

Tool call outputs in the chat history are replaced with compact metadata references (`toolcall_ref id=... tool=... status=...`). Full output is only visible if the tool call object is in the active set.

### 5.2 Ordering

Context assembly should favour stable prefixes for cache efficiency. System prompt and metadata pool are at the top (stable). Chat history follows (append-only). Active content at the end (volatile).

### 5.3 Auto-collapse policy

Recent tool call outputs are auto-activated. Older ones are auto-deactivated based on a sliding window (configurable per-turn limit and turns-back window). Pinned objects are exempt from auto-collapse.

---

## 6) Evaluation and Experiments

### 6.1 Prompt and behaviour policy

- Fixed prompt/protocol is required for fair evaluation phases.
- Harness raw message logs are treated as event input; assembled context is what the model actually sees.

### 6.2 Experiment infrastructure

Experiment scripts are in `scripts/`. Some use a real LLM agent loop (GPT-4.1), some are scripted API exercises. Reports in `docs/experiments/` — see its README for the distinction.

### 6.3 Experiment database isolation

Each experiment should use a clean, isolated database. Options:
- Separate XTDB process with its own data directory per experiment.
- In-memory XTDB backend (`xtdb.mem/->kv-store`) for ephemeral experiment runs.
- Same XTDB instance with unique session IDs per experiment (weaker isolation but no extra processes).

---

## 7) Implementation Status

> Last updated: 2026-02-23.

This section tracks what exists in the repo, not what the design intends. For design intent, see sections 1–6.

### 7.1 Modules

| Module | Path | Status | Notes |
|--------|------|--------|-------|
| XTDB client | `src/xtdb-client.ts` | Working | HTTP client for XTDB v1 standalone. Three endpoints: `submit-tx`, `entity`, `query`. |
| Core types | `src/types.ts` | **Needs update** | Current types predate the object model in §2. Missing: source bindings, identity hash, source hash, session index. |
| Hashing | `src/hashing.ts` | **Needs update** | Has `contentHash`, `metadataViewHash`, `objectHash`. Needs: `sourceHash`, `identityHash`, clear separation per §2.2. |
| Context manager | `src/context-manager.ts` | Working | In-memory pools and cursor processing. Toolcall-only — no file objects. |
| Extension | `src/phase3-extension.ts` | **Needs update** | File indexing, watcher, session persist/resume. File IDs are `file:{path}` — needs filesystem ID. No session index (append-only) separate from metadata pool. |
| Exports | `src/index.ts` | Working | Re-exports public API. |

### 7.2 Test coverage

25 tests across 5 suites, all against real XTDB (no mocks for acceptance):
- `tests/phase1.test.ts` — XTDB client basics (put/get/as-of/history/query)
- `tests/phase2.test.ts` — Context manager pools and cursor
- `tests/phase3.test.ts` — Extension tools, side-effect indexing, activation/lock
- `tests/phase4.test.ts` — Watcher, session resume, cursor invalidation
- `tests/e2e-final.test.ts` — Full lifecycle continuity

### 7.3 What is not yet done

- Object model update: types, hashing, document structure per §2 not yet implemented.
- Source bindings and filesystem identity per §4 not yet implemented.
- Session index (append-only, separate from metadata pool) per §3.1 not yet implemented.
- Not integrated into a live Pi coding agent session.
- Evaluation plan (`docs/eval-plan.md`) documented but unstarted.
- All LLM experiments used investigation/research scenarios; not yet tested on coding tasks.
- Some design decisions remain policy-level (auto-collapse, token budget enforcement).

### 7.4 XTDB deployment

Current: XTDB v1.24.3 standalone with RocksDB backend. Single process on host VPS. 91MB jar, ~477MB data across three RocksDB directories (docs, idx, txs). Config is one EDN file.

Data is portable: copy the three directories to another Linux x64 machine, point XTDB at them, it works.

For in-memory (experiment/sandbox use): swap RocksDB for `xtdb.mem/->kv-store` in EDN config. No persistence, no native dependencies. Suitable for ephemeral runs.

---

## 8) Glossary

- **Object** — versioned entity in the database with stable identity and version history.
- **Sourced object** — object bound to an external source (file, S3, etc.). Source binding is immutable.
- **Unsourced object** — object that exists only in the database (tool call, chat, session).
- **Source** — the external thing a sourced object tracks. Defined by type + type-specific locator fields.
- **Source binding** — the immutable `source` field on a sourced object's envelope.
- **Tracker** — a process watching an external source and pushing updates to the database.
- **Orphaned** — a sourced object whose tracker is no longer active. Normal state, not an error.
- **Session** — one agent's complete interaction state: index, metadata pool, active set, chat, system prompt.
- **Session index** — append-only set of all object IDs a session has encountered.
- **Metadata pool** — mutable subset of the session index. Objects visible as compact metadata in context.
- **Active set** — mutable subset of the metadata pool. Objects with full content loaded in context.
- **Activate/Deactivate** — promote/demote object content between active and metadata-only states.
- **Identity hash** — SHA-256 of an object's immutable envelope. Verifies identity consistency.
- **Source hash** — SHA-256 of the raw external source (e.g., file bytes). Used for efficient change detection.
- **Content hash** — SHA-256 of all mutable payload fields. Detects document-level changes.
- **Filesystem ID** — identifier for a distinct filesystem namespace. Programmatically generated.
- **Client** — an agent process or harness connected to the database. Runs trackers, performs indexing.
- **Harness** — external agent runtime (loop/tools/UI) integrated by adapter/boundary logic.

---

## 9) Change Policy

Update this SSOT whenever behaviour, assumptions, or architecture materially changes.

1. **Behaviour first**: implement or decide the change.
2. **Same commit window**: update this SSOT in the same change set.
3. **Mark impact** as: `Design change`, `Implementation alignment`, or `Implementation divergence`.
4. **Keep §7 honest**: never describe unshipped behaviour as shipped.
5. **Cross-link**: if detailed docs change elsewhere, adjust references here.

Default to documenting uncertainty explicitly rather than over-claiming.
