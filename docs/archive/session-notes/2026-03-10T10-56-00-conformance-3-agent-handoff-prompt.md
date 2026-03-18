# Conformance 3 — Agent Handoff Prompt

You are taking over **Conformance 3 (Agentic SSOT conformance)** for this repo.

## Read first (in order, fully)

1. `/home/bitzaven/.pi/agent/AGENTS.md`
2. `AGENTS.md`
3. `README.md`
4. `docs/intent-ssot-v1.md`  (authority)
5. `docs/implementation-db-ssot-v1.md`
6. `docs/implementation-agentic-ssot-v1.md`  (**primary target**)
7. `docs/archive/session-notes/2026-03-08T17-15-00-agentic-boundary-ssot-checklist.md` (current status/evidence)
8. `src/phase3-extension.ts`
9. `src/storage/storage-port.ts`
10. `src/storage/sqlite-storage.ts` (for query capability awareness)

## Tests to read/update/add

1. `tests/phase3.test.ts`
2. `tests/phase4.test.ts`
3. `tests/e2e-final.test.ts`
4. `tests/storage/ssot-db-boundary-and-profile.test.ts` (ensure boundary not regressed)
5. Add a focused agentic conformance test file if needed (e.g. `tests/agentic/ssot-agentic-conformance.test.ts`)

## Goal

Close remaining gaps to conform runtime context loading to:
- `docs/intent-ssot-v1.md`
- `docs/implementation-agentic-ssot-v1.md`

## Required conformance outcomes

1. **Storage boundary only** in loader/runtime (no direct SQL/table access outside storage layer).
2. **Deterministic context assembly order**:
   - system prompt block
   - metadata/summary block
   - chat history block
   - active content block
   and stable ordering inside each block.
3. **Session-head-driven resolution** from latest session version payload refs.
4. **Ref semantics honored**:
   - dynamic refs resolve to target HEAD
   - pinned refs resolve to pinned version/hash anchor
5. **Unresolved refs are visible** (not dropped, not crashing).
6. **Metadata-first policy** for inactive objects.
7. **Only active/pinned content expanded by default** unless explicitly widened.

## Constraints

- Tests passing is necessary but not sufficient: provide direct evidence for each conformance claim.
- Do not mock/fake conformance behavior.
- If blocked, state blocker explicitly; do not silently degrade semantics.

## Verify loop (required)

Run at minimum:
- `npm run build`
- `npm test`

Also run at least one manual runtime verification script that demonstrates:
- dynamic vs pinned behavior divergence after target updates
- unresolved ref visibility
- deterministic repeated assembly for unchanged storage state

## Deliverable format

1. Assumptions
2. Files changed
3. Conformance claims mapped to exact SSOT clauses
4. Evidence (commands + observed outputs)
5. Remaining gaps/blockers (if any)
