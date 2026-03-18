# Docs

## Canonical active docs

1. `intent-ssot-v1.md` — **Intent SSOT** (authoritative behavior/invariants)
2. Source docstrings — **authoritative implementation documentation**
   - `src/storage/storage-port.ts`
   - `src/storage/sqlite-schema.ts`
   - `src/storage/sqlite-storage.ts`
   - `src/phase3-extension.ts`
   - `.pi/live-drive/scm-live-drive.ts`
3. `generated/implementation-reference.md` — generated implementation reference compiled from source docstrings (read-only convenience output)

Authority precedence:
- Intent (`intent-ssot-v1.md`) is authoritative for subsystem semantics.
- Implementation details live in source docstrings adjacent to the code they describe.
- Generated docs are derived artifacts, not the canonical source.

## Implementation docs workflow

- Generate implementation docs: `npm run docs:generate`
- Check generated docs are up to date: `npm run docs:check`

## Current profile summary

- Intent stays in external docs.
- Durable implementation details live in source docstrings.
- Historical markdown implementation SSOT snapshots were archived under `docs/archive/spec-legacy/` on 2026-03-11.

## Historical/non-normative docs

- `docs/archive/` — historical snapshots and non-normative notes.
  - `docs/archive/spec-legacy/` — superseded spec/SSOT snapshots, including pre-docstring implementation markdown docs.
  - `docs/archive/build-notes-legacy/` — historical rebuild notes and execution logs.
  - `docs/archive/experiments-legacy/` — experimental methodology, data, and reports.
  - `docs/archive/session-notes/` — archived working/session notes and handoff prompts.
  - `docs/archive/write-down/` — dated checkpoint notes.
- `docs/temp/` — temporary working notes only; archive at checkpoints/handoff.
