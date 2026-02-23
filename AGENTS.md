# AGENTS.md

## Reading order

1. This file
2. `README.md` — project overview, "where to start" routing
3. `docs/spec/context-manager-ssot.md` — authoritative spec (sections 1-2 for design, section 3 for implementation status)

## What to know

This is a context management layer for LLM agents, built as a Pi coding agent extension. It gives the agent explicit control over what's in its context window via activate/deactivate on versioned objects stored in XTDB.

As of 2026-02-23: working prototype, 25/25 tests passing against real XTDB, LLM-driven experiments completed on investigation scenarios. Not yet tested on a real coding task.

## Where to put things

- **Spec changes** → update `docs/spec/context-manager-ssot.md` (the SSOT is the single source of truth; update it in the same commit as the change)
- **Experiment reports** → `docs/experiments/reports/` with a date prefix
- **Experiment data** → `docs/experiments/data/`
- **Experiment outputs** (LLM-generated files) → `docs/experiments/outputs/`
- **New fixtures** → `fixtures/<scenario-name>/`
- **Build/decision notes** → `docs/build-notes/`

Everything goes in this repo. Don't leave artifacts in your workspace or tmp.

## XTDB dependency

XTDB v1 standalone (RocksDB backend) runs as a separate JVM process. The jar is in `xtdb/` (gitignored). Config is `xtdb/xtdb.edn`. Tests and scripts expect it at `http://172.17.0.1:3000` by default (override with `XTDB_URL` env var).

This is currently a pain point — see the portability discussion in the README or SSOT if it's been updated. As of 2026-02-23, XTDB only runs on the host VPS, not in sandboxes or Docker.

## Running

```bash
# XTDB must be running first (external process)
npm run build
npm test          # 25/25 expected
```

Experiment scripts are in `scripts/`. The LLM-driven ones need `OPENAI_API_KEY`.
