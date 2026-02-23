# Self Context Manager

Context management layer for LLM agents. Controls what is kept, retrieved, and surfaced in the active context window over time. Built as a [Pi coding agent](https://github.com/badlogic/pi-mono) extension.

## Status (as of 2026-02-23)

Working prototype. Four build phases completed with real XTDB (no mocks), 25/25 tests passing. LLM-driven experiments (GPT-4.1) show prompt policy meaningfully changes context management behaviour — baseline agents never deactivate context; with hygiene prompts they do, and with the right task shape they also recall earlier evidence. All experiments used investigation/research scenarios; not yet tested on a real coding task.

## Where to start

**If you're trying to understand what this is:** Read [the SSOT](docs/spec/context-manager-ssot.md) sections 1-2 (problem, goals, design decisions).

**If you're trying to understand what's built:** Read [the SSOT](docs/spec/context-manager-ssot.md) section 3 (implementation status), then look at `src/`.

**If you're trying to understand the experiments:** Read [docs/experiments/README.md](docs/experiments/README.md) — it separates LLM-driven experiments from scripted API validation and summarises key findings.

**If you're trying to build or extend:** Read [docs/build-notes/plan.md](docs/build-notes/plan.md) for the original build plan and phase structure, then [docs/build-notes/rebuild-final-report.md](docs/build-notes/rebuild-final-report.md) for what was actually built and how to rerun it.

**If you're trying to run it:**
```bash
# Start XTDB
./scripts/xtdb-start.sh

# Build
npm run build

# Run tests (25/25 expected)
npm test
```

## Structure

```
src/                        # TypeScript source (6 modules)
tests/                      # Unit + integration tests (vitest, 5 suites, 25 tests)
scripts/                    # Experiment scripts + XTDB start/stop
fixtures/                   # Seed data for experiments (investigation scenarios)
docs/
  spec/                     # Design spec (SSOT is authoritative)
  experiments/              # Reports, outputs, data, methodology
  build-notes/              # Build plan, decision log, phase notes
  eval-plan.md              # Evaluation roadmap (ablations, holdout tasks)
xtdb/                       # XTDB config (jar/logs/pid gitignored)
```

## Spec

**Authoritative:** [Context Manager SSOT](docs/spec/context-manager-ssot.md). If anything else conflicts, the SSOT wins.

Historical design docs in `docs/spec/` — see [its README](docs/spec/README.md) for which is current.

## License

MIT
