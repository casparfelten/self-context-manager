# AGENTS.md

## Reading order

1. This file
2. `README.md` — project overview
3. `docs/intent-ssot-v1.md` — intent authority
4. `docs/implementation-db-ssot-v1.md` — DB/storage contract
5. `docs/implementation-agentic-ssot-v1.md` — agentic/runtime contract

## What to know

This repo is a context management layer for LLM agents, implemented as a Pi coding agent extension.

Current active backend is SQLite through `StoragePort`.

## Where to put things

- **Intent changes** → `docs/intent-ssot-v1.md`
- **DB/storage contract changes** → `docs/implementation-db-ssot-v1.md`
- **Agentic/runtime contract changes** → `docs/implementation-agentic-ssot-v1.md`
- **Session notes / temporary execution notes** → `docs/temp/`
- **Historical write-downs** → `docs/archive/write-down/`

Everything goes in this repo. Don’t leave artifacts in workspace tmp directories.

## Running

```bash
npm run build
npm test
```

## Operational note

Legacy backend artifacts were removed from the active implementation path.
If behavior appears incomplete in legacy areas, implement on top of `StoragePort`/SQLite rather than reintroducing old backend code.
