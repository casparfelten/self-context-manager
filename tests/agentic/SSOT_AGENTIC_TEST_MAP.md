# Agentic SSOT v1 test map

Source of rules: `docs/implementation-agentic-ssot-v1.md`

As-of: 2026-03-10

## §1 Boundary with storage
- `tests/agentic/ssot-agentic-conformance.test.ts`
  - `uses StoragePort boundary only in runtime loader (no direct sqlite usage in SelfContextManager)`

## §2 Loader inputs and anchors
- `tests/agentic/ssot-agentic-conformance.test.ts`
  - `resolves from latest session HEAD refs ...`
  - `surfaces version_conflict instead of silently clobbering externally advanced session HEAD`

## §3 Context assembly contract
- `tests/agentic/ssot-agentic-conformance.test.ts`
  - deterministic block-order assertions (`system`, `metadata`, chat/history, `ACTIVE_CONTENT`)
  - deterministic repeat-assembly assertion (`assembledAgain === assembled`)
  - metadata-first + inactive-by-ref coverage

## §4 Reference resolution behavior in loader
- `tests/agentic/ssot-agentic-conformance.test.ts`
  - dynamic vs pinned divergence assertion after target update
  - unresolved reference visibility assertion in metadata summary

## §5 Session mutation interaction model
- `tests/agentic/ssot-agentic-conformance.test.ts`
  - latest session HEAD behavior (external head advance + conflict surfaced)

## §6 Out-of-scope for agentic loader v1
- `tests/agentic/ssot-agentic-conformance.test.ts`
  - no direct SQL usage assertion for runtime loader source

## Known coverage gaps (current)
1. No direct tests yet for query-based reverse dependency surfaces in runtime output (storage API is covered separately under `tests/storage/`).
2. No explicit wide-expansion mode tests (default metadata-first behavior is covered; optional wider expansion mode is not currently exposed).
