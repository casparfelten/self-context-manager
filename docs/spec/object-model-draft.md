# Object Model — Draft

> Working document. Not yet authoritative. Will be merged into the SSOT once reviewed.

This describes the data model for objects, sessions, sources, and tracking. It refines and extends SSOT sections 2.1–2.6.

---

## 1) Objects

An object is a versioned thing in the database. Every object has:

- **ID** — stable, assigned once, never changes.
- **Schema metadata** — immutable fields that define what the object *is*. Type, source binding (if any), structural identity. Set at creation, never modified. This is the object's "birth certificate."
- **Content** — the payload. Mutable across versions. Can be null (object exists but content is absent — e.g., deleted file, non-text file, orphaned source).
- **Operational metadata** — mutable fields that change across versions alongside content. Char count, content hash, etc.
- **Version history** — maintained by XTDB's bi-temporal store. Every put creates a new version. History is never erased.

### Object types

**Sourced objects** — bound to an external thing. The source binding is part of the schema metadata and defines identity. Examples: a file on a filesystem, an S3 object, a git blob (future). The object tracks the state of that external thing over time. If the source disappears, the object is orphaned (latest version has null content) but the object and its history remain.

**Unsourced objects** — exist only in the database. No external binding. Tool call results, chat records, session state. Identity is just a generated ID.

### Object identity

For **unsourced objects**: ID is generated at creation (e.g., the tool call ID, `chat:{sessionId}`, etc.).

For **sourced objects**: ID is derived from the source binding. Specifically, from the source type + source locator. Two clients indexing the same source get the same object, because the source determines the ID, not the client.

For files, this means: `file:{filesystemId}:{absolutePath}`. Two agents on the same filesystem reading the same path → same object. An agent in a different sandbox reading the same path → different object (different filesystem ID → different source → different ID).

---

## 2) Sources and tracking

A **source** is an external thing an object is bound to. It has:

- **Source type** — what kind of thing it is. `filesystem` for now. `s3`, `git`, etc. later.
- **Source locator** — type-specific fields that uniquely identify the thing. For filesystem: `{filesystemId, absolutePath}`. For S3: `{bucket, key}`. Etc.

A **tracker** is a process that watches a source and pushes updates to the database. For filesystem sources, this is a file watcher (chokidar today). For S3, it might be a poller. For git, it might be a webhook listener.

Tracking is optional and can be interrupted. An object can exist without an active tracker — this is the **orphaned** state. The object retains its source binding (we still know *what* it was tracking) but no process is currently watching it. Orphaning is normal. Common causes: sandbox destroyed, machine offline, file deleted. A tracker can be re-attached later if the source becomes available again.

### Tracker lifecycle

- **Attached**: a tracker is actively watching the source and will push updates on change.
- **Orphaned**: no tracker is active. The object's latest version reflects the last known state. It may have null content if the source was explicitly deleted, or stale content if the tracker just stopped (machine went offline).
- **Resumed**: a tracker re-attaches to an orphaned object. It checks current source state, creates a new version if changed.

Trackers are per-client — a client runs trackers for the sources it has access to. Multiple clients can run trackers for the same source (two agents on the same machine watching the same file). Any of them can push updates; they all resolve to the same object.

---

## 3) Filesystem identity

A filesystem ID identifies a distinct filesystem namespace. Two paths on the same filesystem ID refer to the same files. Two paths on different filesystem IDs are assumed to be independent even if the path strings match.

The client declares its filesystem ID when it connects. This should be generated programmatically from the environment — not a human-chosen label. Candidates:

- For a host machine: a stable machine identifier (machine-id, hostname, or similar) + the relevant mount/root.
- For a Docker container/sandbox: the container ID, sandbox ID, or a hash of the filesystem root that distinguishes it from the host.
- For bind-mounted directories: if a sandbox bind-mounts a host directory, the agent in the sandbox and the agent on the host are accessing the same files. Their filesystem IDs for that mount should match if we want edits to be shared. This is a policy decision for the harness to make — it knows the mount topology.

The database trusts the declared filesystem ID. It does not verify that two clients with the same filesystem ID actually share a filesystem. Clients are assumed trusted.

---

## 4) Indexing flow

When a client encounters a file (reads it, sees it in `ls` output, etc.), it indexes it:

1. Client computes the source locator: `{type: 'filesystem', filesystemId: X, path: Y}`.
2. Client computes a hash of the object's current state: content hash + operational metadata hash. This is cheap (SHA-256 of content + a few fields).
3. Client sends to the database: source locator + state hash (+ full content if it's the first index or hash differs from last known).

The database resolves:

- **New source** (never seen this locator before): create new object with this source binding. Store first version. Return new object ID.
- **Known source, hash unchanged**: no-op. Return existing object ID.
- **Known source, hash changed**: append new version with updated content/metadata. Return existing object ID.

In the common case (file hasn't changed), this is one hash comparison — no content upload, no write.

### What gets hashed

The state hash covers everything that would constitute a new version:
- Content (the actual payload)
- Operational metadata (char count, file type, etc.)

It does NOT cover schema metadata (source binding, object type) because those are immutable — they can't change between versions.

---

## 5) Sessions

A session is the complete state of one agent's interaction with the database. It is the portable unit — everything needed to pause, move, and resume an agent's work.

### Session wrapper

One top-level object that references everything in the session:

- **Session ID** — stable identifier.
- **Chat reference** — the chat object for this session's conversation history.
- **System prompt reference** — the system prompt object.
- **Session index** — append-only list of every object this session has ever encountered. Immutable once an object is added. If a file is deleted, the object stays in the index (its latest version has null content, but the index entry remains). This is the full record.
- **Metadata pool** — mutable subset of the session index. Objects currently loaded as compact metadata in the agent's context window. The agent/policy can add or remove objects from this pool.
- **Active set** — mutable subset. Objects whose full content is loaded in context. Subset of metadata pool (if it's active, it's also in metadata).
- **Pinned set** — objects the agent has explicitly pinned (policy-dependent behaviour, e.g., won't be auto-deactivated).

### What the agent controls

- Metadata pool membership (which indexed objects are visible as metadata)
- Active set membership (which objects have content loaded)
- Pinned set membership
- Triggering new object creation (by reading files, running tools)

### What the agent does not control

- Session index (append-only, cannot remove entries)
- Object version history (cannot rewrite or delete versions)
- Object schema metadata (immutable)
- Other sessions' state

### Session lifecycle

- **Active**: agent is running, session state is being updated each turn.
- **Paused**: agent is not running. Session state is persisted in the database. Can be resumed.
- **Resumed**: session is loaded from database. Tracked objects are checked against their sources and re-versioned if changed. Orphaned objects are detected. Active/metadata/pinned sets are restored.

---

## 6) Layers summary

From bottom to top:

| Layer | What it is | Mutability | Scope |
|-------|-----------|------------|-------|
| Object store (XTDB) | All objects, all versions, all sessions | Append-only (new versions, never delete) | Global — shared across all sessions |
| Object schema metadata | Type, source binding, structural identity | Immutable per object | Per object |
| Object content + operational metadata | Payload and derived fields | New version per change | Per object |
| Source + tracker | External binding + watch process | Tracker can attach/detach; source binding is immutable | Per object |
| Session index | Every object this session has encountered | Append-only | Per session |
| Metadata pool | Objects loaded as metadata in context | Mutable (add/remove) | Per session |
| Active set | Objects with full content in context | Mutable (add/remove) | Per session |
| Pinned set | Agent-pinned objects | Mutable (add/remove) | Per session |
| Session wrapper | Top-level object bundling all of the above | Updated each turn | Per session |

---

## 7) Open decisions

1. **Filesystem ID generation** — exact mechanism for programmatic generation. Machine-id? Container ID? Needs to handle bind mounts correctly.

2. **Hash-based indexing protocol** — exact fields included in the state hash. Current codebase has `content_hash`, `metadata_view_hash`, `object_hash` — these may map directly or need adjustment.

3. **Source types beyond filesystem** — S3, git, etc. are mentioned as future. The source type + locator pattern should accommodate them but we don't need to design them now.

4. **Metadata pool vs session index distinction in storage** — currently the code has one list (metadata pool). Need to add the session index as a separate append-only structure.

5. **Cross-session object discovery** — can a session discover objects indexed by another session? Currently no mechanism for this. May want it for the "shared database, multiple agents" case.

6. **Orphan detection and recovery** — how does a resumed session know which of its tracked objects are orphaned vs just not yet checked? Current code does a reconciliation pass on resume; this may need to be more explicit.
