# Agentic boundary + DB SSOT compliance checklist (tight verify loop)

Date: 2026-03-08 (UTC)
Scope: `src/phase3-extension.ts`, `src/storage/*`, storage-facing tests
Authority:
- `docs/intent-ssot-v1.md`
- `docs/implementation-db-ssot-v1.md`
- `docs/implementation-agentic-ssot-v1.md`

## Assumptions
1. "Agentic boundary" means runtime/context loader code must not read DB tables directly and must consume storage through `StoragePort` methods.
2. "Fully SSOT-compliant" for this pass is limited to the requested implementation/test files, not a full repo-wide architecture rewrite.

## Checklist

- [x] **No direct SQLite/SQL usage in non-storage runtime files**
  - Evidence command:
    - `rg -n "from 'node:sqlite'|DatabaseSync|\bprepare\(|\bexec\(" src --glob '!src/storage/**' || true`
  - Result: no matches.

- [x] **`SelfContextManager` reads via `StoragePort` methods (boundary preserved)**
  - Evidence:
    - `src/phase3-extension.ts:60` (`private readonly storage: StoragePort`)
    - `src/phase3-extension.ts:250,258,584,642,665,672` (`getLatest`, `getHistory`, `putVersion` calls)

- [x] **`putVersion` union includes explicit validation result branch**
  - Evidence:
    - `src/storage/storage-port.ts:79` includes `{ ok: false; validation: true; reason: 'invalid_session_id' }`

- [x] **Step-0 session validation implemented before transactional/idempotency path**
  - Evidence:
    - `src/storage/sqlite-storage.ts:113` early return for invalid session identity
    - `src/storage/sqlite-storage.ts:361` `isInvalidSessionIdentity(...)`

- [x] **Idempotency decision occurs before optimistic guard and before ref validation side-effects**
  - Evidence:
    - `src/storage/sqlite-storage.ts:122` idempotency lookup
    - `src/storage/sqlite-storage.ts:124` fingerprint compare (`computeIdempotencyFingerprint`)
    - `src/storage/sqlite-storage.ts:145` optimistic `expectedCurrentVersionId` check after idempotency branch
    - `src/storage/sqlite-storage.ts:155-156` `normalizePutInput` + `extractRefs` executed only after idempotency check for non-replay path

- [x] **DB-level enforcement exists for session identity (defense in depth)**
  - Evidence:
    - `src/storage/sqlite-schema.ts:31` `session_id` trim/non-empty CHECK
    - `src/storage/sqlite-schema.ts:84-95` trigger `trg_session_version_requires_session_id` with `RAISE(ABORT, 'invalid_session_id')`

- [x] **Runtime handles validation vs conflict branches distinctly**
  - Evidence:
    - `src/phase3-extension.ts:680` `storage_validation:...`
    - `src/phase3-extension.ts:682` `storage_conflict:...`

- [x] **Manual non-test verification executed (beyond unit tests)**
  - Evidence command: ad-hoc Node script run against built `dist` storage implementation.
  - Observed output: `agentic_boundary_manual_verify:ok`
  - Script assertions covered:
    1. invalid session write => validation result + no write side effects,
    2. idempotency mismatch returned before ref parsing on reused `request_id`,
    3. direct SQL insert into session version without `session_id` fails via trigger,
    4. reverse ref lookup + object hash preimage contract still holds.

## Build and targeted verification commands run
1. `npm run build`
2. `npm test -- tests/storage/ssot-db-put-version-contract.test.ts tests/storage/ssot-db-schema-indexes.test.ts tests/storage/ssot-db-boundary-and-profile.test.ts tests/storage/ssot-db-refs-session-hashes.test.ts`
3. manual Node verification script (see shell history for full script)

Status: **PASS for this scoped SSOT compliance pass**.
