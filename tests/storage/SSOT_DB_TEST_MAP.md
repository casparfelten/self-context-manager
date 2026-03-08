# DB SSOT v1 test map

Source of rules: `docs/implementation-db-ssot-v1.md`

## §1 Implementation profile (minimal core)
- Includes profile assertions:
  - `tests/storage/ssot-db-boundary-and-profile.test.ts`
    - `§1 includes immutable version store + idempotent writes + typed envelope fields in object_versions`
    - `§1 includes explicit structured references + session tracking via session object versions`
- Excludes profile assertions:
  - `tests/storage/ssot-db-boundary-and-profile.test.ts`
    - `§10 out-of-scope: ...` tests (table/column/API absence)

## §2 Core invariants
All 10 invariants are covered in:
- `tests/storage/ssot-db-core-invariants.test.ts`
  - `§2.1 object identity...`
  - `§2.2 immutability...`
  - `§2.3 version_no...`
  - `§2.4 tx_seq...`
  - `§2.5 single HEAD...`
  - `§2.6 typed envelope...`
  - `§2.7 content_struct_json...`
  - `§2.8 metadata_json...`
  - `§2.9 references derived only...`
  - `§2.10 missing targets...`

## §3 SQLite schema
- `tests/storage/ssot-db-schema-indexes.test.ts`
  - `§3 objects table: exact columns and FK ...`
  - `§3 object_versions table: exact columns + JSON CHECKs + UNIQUEs + FK ...`
  - `§3 doc_references table: exact columns + CHECK/FK contracts`
  - `§3 write_idempotency table: exact columns + PK(request_id)`
  - `§3 enum/CHECK constraints reject invalid data at DB level`
  - `§3 doc_references pinned/mode/metadata JSON checks reject invalid rows`

## §4 Recommended indexes
- Existence + key-columns:
  - `tests/storage/ssot-db-schema-indexes.test.ts`
    - `§4 recommended indexes exist with expected key columns`
- Real query-plan usage:
  - `tests/storage/ssot-db-query-plan.test.ts`
    - `uses idx_versions_session_id...`
    - `uses idx_refs_target_version / idx_refs_target_hash...`
    - `uses partial unresolved index idx_refs_resolved...`

## §5 Write transaction contract (`putVersion`)
- `tests/storage/ssot-db-put-version-contract.test.ts`
  - Step 1 replay / mismatch
  - Ordering rule (idempotency before optimistic conflict)
  - Step 2 object ensure
  - Step 3 optimistic guard conflict
  - Step 4 nextVersionNo
  - Step 5 typed-envelope consistency
  - Step 6 immutable version insert
  - Step 7 head + updated fields update
  - Step 8 ref extraction + per-version storage
  - Step 9 refs_hash deterministic storage
  - Step 10 write_idempotency row insert
  - Step 11 commit + returned success
  - Atomic rollback failure-path

## §6 Reference extraction contract
- `tests/storage/ssot-db-refs-session-hashes.test.ts`
  - `§6.1 extracts refs only ... declared ref-bearing fields`
  - `§6.2 validates minimal Ref runtime contract fields`
  - `§6.3 stores all extracted ref fields, including resolved bit`
  - `§6.4 refs_hash is deterministic under input ordering permutations`

## §7 Session realization
- `tests/storage/ssot-db-refs-session-hashes.test.ts`
  - `§7.1 session realization...`
  - `§7.1 session payload shape required fields...`
  - `§7.1 session_id ... canonical anchor across versions`
  - `§7.1 no separate mutable session-state table ...`

## §8 Hash contract realization
- `tests/storage/ssot-db-refs-session-hashes.test.ts`
  - `§8 stores content_struct_hash...object_hash...`
  - `§8 object_hash preimage follows H("v1|...")`

## §9 StoragePort boundary
- `tests/storage/ssot-db-boundary-and-profile.test.ts`
  - `§9 StoragePort boundary exposes required methods`
  - `§9 putVersion returns success/ conflict union shapes ...`

## §10 Out-of-scope
- `tests/storage/ssot-db-boundary-and-profile.test.ts`
  - no `doc_nodes` table
  - no temporal columns / field-hash pinning columns
  - no built-in FTS tables
  - no as-of/GC/full-text APIs on storage boundary
