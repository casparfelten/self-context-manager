# Pi-Memory Rebuild Decision Log — 2026-02-22

## Scope and constraints

**Run scope**
- Rebuild run decision record for pi-memory.
- Capture decisions, rationale, rejected alternatives, and verification evidence by phase.
- This document is the auditable trail for go/no-go and merge readiness.

**Execution constraints**
- Documentation-only changes for this step.
- No modifications to implementation code or behavior (`src/`, `tests/`, package config, scripts).
- Record only current setup and explicit outcomes observed; no speculative completion claims.

## Non-negotiables

1. **Real XTDB only**
   - All verification must use real XTDB flows/services.
   - No mocked XTDB paths for acceptance evidence.
2. **No mocks for acceptance truth**
   - Test doubles may not be used as final proof for integration correctness.
3. **Clean, minimal code intent**
   - Rebuild decisions must prefer smallest correct change-set.
   - Remove incidental complexity when a simpler equivalent exists.
4. **Evidence-first merge discipline**
   - Every accepted phase decision must include reproducible evidence references.

## Phase checkpoints template (Phase 1–4)

> Status key: `Pending` | `In Progress` | `Blocked` | `Complete`

### Phase 1
- **Status:** Pending
- **Decision:** _TBD_
- **Rationale:** _TBD_
- **Alternatives rejected:** _TBD_
- **Evidence required:**
  - [ ] Linked test output/artifacts
  - [ ] Manual XTDB flow notes (inputs, commands, observed outputs)
  - [ ] Risk notes + rollback/mitigation statement

### Phase 2
- **Status:** Pending
- **Decision:** _TBD_
- **Rationale:** _TBD_
- **Alternatives rejected:** _TBD_
- **Evidence required:**
  - [ ] Linked test output/artifacts
  - [ ] Manual XTDB flow notes (inputs, commands, observed outputs)
  - [ ] Regression check summary

### Phase 3
- **Status:** Pending
- **Decision:** _TBD_
- **Rationale:** _TBD_
- **Alternatives rejected:** _TBD_
- **Evidence required:**
  - [ ] Linked test output/artifacts
  - [ ] Manual XTDB flow notes (inputs, commands, observed outputs)
  - [ ] Performance/behavior deltas (if applicable)

### Phase 4
- **Status:** Pending
- **Decision:** _TBD_
- **Rationale:** _TBD_
- **Alternatives rejected:** _TBD_
- **Evidence required:**
  - [ ] Linked test output/artifacts
  - [ ] Manual XTDB flow notes (inputs, commands, observed outputs)
  - [ ] Final readiness + outstanding risk statement

## Verification evidence checklist template

### Automated tests
- [ ] Test command(s) recorded verbatim
- [ ] Exit status captured
- [ ] Relevant suite/case output attached or linked
- [ ] Environment/context noted (service deps, versions, flags)

### Manual XTDB flow (real system)
- [ ] XTDB instance details captured (endpoint/container/service id)
- [ ] Seed/setup commands documented
- [ ] Query/write steps documented with timestamps
- [ ] Observed results captured (not paraphrased when possible)
- [ ] Negative-path or edge-case check recorded
- [ ] Cleanup/reset steps recorded

### Evidence quality bar
- [ ] Reproducible by another engineer from notes alone
- [ ] Distinguishes expected vs observed behavior
- [ ] Includes artifact locations (logs, screenshots, output files)

## Blocker protocol (fix vs escalate)

1. **Declare blocker immediately** with:
   - Symptom
   - Scope impact (phase/task affected)
   - First-fail evidence (command/log excerpt)
2. **Triage window (time-boxed):**
   - Attempt minimal, reversible fix path first.
   - If root cause is outside current phase scope or risks non-minimal churn, escalate.
3. **Decision rule:**
   - **Fix now** when change is small, local, and evidence can be produced in-phase.
   - **Escalate** when dependency/architecture uncertainty or cross-phase risk is high.
4. **Escalation packet must include:**
   - What was attempted
   - Why blocked remains
   - Options with risk/cost tradeoff
   - Recommended next action and owner
5. **Post-resolution update:**
   - Link blocker entry to final decision and evidence.

## Merge gate checklist

- [ ] All four phases have explicit decision entries
- [ ] Each phase includes rationale + alternatives rejected
- [ ] Required evidence checklists are complete and linked
- [ ] Non-negotiables confirmed (real XTDB, no mock acceptance proof, minimal clean approach)
- [ ] All blockers resolved or explicitly accepted with owner and follow-up
- [ ] No out-of-scope file changes included in merge
- [ ] Reviewer can replay verification from documented commands/artifacts

## Initial run setup entries (current state only)

- **Run date:** 2026-02-22
- **Document owner:** decagent/docs track
- **Current phase outcomes:** Not yet recorded (all phases pending)
- **Known governance baseline:**
  - Real XTDB required for acceptance evidence
  - No mock-based acceptance claims
  - Keep rebuild changes minimal and clean
- **Next required updates:** Populate each phase section only after decision + evidence exist.
