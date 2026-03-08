# Session note — removed legacy external backend artifacts

Date (UTC): 2026-03-08T02:55:00
Scope: remove legacy backend code/tests/scripts from active implementation path.

## Removed from active path

- `src/xtdb-client.ts`
- `tests/phase1.test.ts`
- all files under `scripts/` (legacy backend experiment/start-stop scripts)
- `xtdb/xtdb.edn`
- `tests/ssot-conformance/` (legacy spec-conformance suite tied to old document model)

## API/runtime cleanup

- `SelfContextManager.getXtEntity()` removed → `SelfContextManager.getEntity()`
- `src/index.ts` no longer exports legacy backend client.
- Runtime and tests now target only `StoragePort`/SQLite path.

## Documentation cleanup

- Updated active docs (`README.md`, `docs/README.md`, `AGENTS.md`, SSOT cross-doc refs) to remove legacy backend references.

## Incomplete / blocked removals (recorded)

- `archive/xtdb-prototype/` directory removal is blocked by parent directory permissions (`archive/` is root-owned in this environment).
  - Contents were removed; empty directory remains.
- Historical files under `docs/archive/**` still include legacy backend mentions by design (non-normative history).

## Validation

- `npm run build --silent` → pass
- `npm test --silent` → pass (`74 passed`)
