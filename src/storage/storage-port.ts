/**
 * @impldoc StoragePort implementation boundary
 *
 * `StoragePort` is the active implementation-level boundary between the runtime
 * and durable storage. Runtime/context-loading code should consume versioned
 * state only through this interface rather than reading SQLite tables directly.
 *
 * Active profile guarantees exposed here:
 * - immutable per-object version writes
 * - explicit separation between validation failures and optimistic conflicts
 * - mandatory non-empty `sessionId` for `objectType='session'`
 * - reference traversal through query methods rather than direct DB access
 *
 * This file is canonical for the public storage contract at the implementation
 * level; generated implementation docs are compiled from these docstrings.
 */
export type ObjectType = 'file' | 'toolcall' | 'chat' | 'session' | 'system_prompt';
export type WriterKind = 'client' | 'watcher' | 'system';
export type WriteReason = 'manual' | 'watcher_sync' | 'import' | 'system';
export type ReferenceMode = 'dynamic' | 'pinned';

/**
 * @impldoc Version write envelope
 *
 * `VersionWriteInput` is the canonical write envelope for the active storage
 * profile. Typed envelope fields (`path`, `sessionId`, `toolName`, `status`,
 * `charCount`) are part of the durable version contract rather than convenience
 * projections.
 *
 * Session rule:
 * - `sessionId` is required and non-empty when `objectType='session'`
 *
 * Conflict rule:
 * - `expectedCurrentVersionId` drives optimistic head checking
 * - `requestId` drives idempotent replay semantics
 */
export interface VersionWriteInput {
  requestId: string;

  objectId: string;
  objectType: ObjectType;

  writerId: string;
  writerKind: WriterKind;
  writeReason: WriteReason;

  contentStruct: unknown;
  fileBytes?: Uint8Array | null;

  path?: string | null;
  // required and non-empty when objectType='session'
  sessionId?: string | null;
  toolName?: string | null;
  status?: string | null;
  charCount?: number | null;

  metadata: Record<string, unknown>;

  expectedCurrentVersionId?: string;
  txTime?: string;
}

export interface VersionRecord {
  txSeq: number;
  versionId: string;
  objectId: string;
  versionNo: number;

  txTime: string;

  writerId: string;
  writerKind: WriterKind;
  writeReason: WriteReason;

  contentStructJson: string;
  fileBytesHash: string | null;

  path: string | null;
  sessionId: string | null;
  toolName: string | null;
  status: string | null;
  charCount: number | null;

  metadataJson: string;

  contentStructHash: string;
  metadataHash: string;
  refsHash: string;
  objectHash: string;
}

export interface ReferenceRecord {
  refId: string;
  fromVersionId: string;
  fromPath: string;

  targetObjectId: string;
  targetVersionId?: string;
  targetObjectHash?: string;

  refKind: string;
  mode: ReferenceMode;
  resolved: boolean;
  refMetadataJson?: string;
}

/**
 * @impldoc StoragePort read/write API
 *
 * `putVersion` returns one of three outcome classes:
 * - success with a durable `VersionRecord`
 * - validation failure (`invalid_session_id`)
 * - conflict (`version_conflict` or `idempotency_mismatch`)
 *
 * Loader/runtime read behavior is intentionally narrow:
 * - `getLatest` / `getHistory` for object state
 * - reference queries for dependency traversal
 *
 * This keeps the loader on the `StoragePort` boundary and avoids direct SQL
 * coupling in the active runtime.
 */
export interface StoragePort {
  putVersion(input: VersionWriteInput): Promise<
    | { ok: true; record: VersionRecord; idempotentReplay: boolean }
    | { ok: false; validation: true; reason: 'invalid_session_id' }
    | { ok: false; conflict: true; reason: 'version_conflict' | 'idempotency_mismatch' }
  >;

  getLatest(objectId: string): Promise<VersionRecord | null>;
  getHistory(objectId: string, order?: 'asc' | 'desc'): Promise<VersionRecord[]>;

  queryReferences(params: {
    fromVersionId?: string;
    fromPathPrefix?: string;
    targetObjectId?: string;
    targetVersionId?: string;
    targetObjectHash?: string;
    mode?: ReferenceMode;
    resolved?: boolean;
    limit?: number;
  }): Promise<ReferenceRecord[]>;

  getReferrersByTargetVersion(
    targetVersionId: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]>;

  getReferrersByTargetHash(
    targetObjectHash: string,
    params?: { mode?: ReferenceMode; resolved?: boolean; limit?: number },
  ): Promise<ReferenceRecord[]>;
}
