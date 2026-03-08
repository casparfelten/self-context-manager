# Docs

## Canonical active docs

1. `intent-ssot-v1.md` — **Intent SSOT** (authoritative behavior/invariants)
2. `implementation-db-ssot-v1.md` — **DB Implementation SSOT** (SQLite schema + transactional storage contract)
3. `implementation-agentic-ssot-v1.md` — **Agentic Implementation SSOT** (context loading behavior + query-interface boundary)

Authority precedence:
- Intent (`intent-ssot-v1.md`) is canonical for subsystem semantics.
- DB and Agentic implementation SSOTs must conform to intent.

## Canonical profile summary (v1)

- Minimal immutable version store with idempotent writes
- Global monotonic `tx_seq` + per-object monotonic `version_no`
- Explicit structured references with dynamic/pinned modes
- First-class session tracking via `session` object versions
- Canonical typed envelope fields (`path`, `session_id`, `tool_name`, `status`, `char_count`)

Explicitly out of scope in this profile:
- `doc_nodes` structural projection
- temporal validity intervals / as-of-time API
- field-hash pinning
- built-in FTS and GC APIs

## Historical/non-normative docs

- `docs/archive/` — historical snapshots moved out of canonical path.
  - `docs/archive/spec-legacy/` — prior SSOT/implementation docs (superseded).
  - `docs/archive/build-notes-legacy/` — rebuild notes and historical execution logs.
  - `docs/archive/experiments-legacy/` — experimental methodology, data, and reports.
  - `docs/archive/eval-plan-legacy.md` — evaluation roadmap (historical).
- XTDB prototype archive:
  - `archive/xtdb-prototype/`
