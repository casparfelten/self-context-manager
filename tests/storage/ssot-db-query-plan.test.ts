import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  baseWrite,
  cleanupStorageHarness,
  createStorageHarness,
  openInspectDb,
  type StorageHarness,
} from './test-helpers.js';

describe('DB SSOT §4 indexes are used by canonical query shapes', () => {
  let harness: StorageHarness;
  let inspect: DatabaseSync;

  beforeEach(async () => {
    harness = await createStorageHarness();
    inspect = openInspectDb(harness.dbPath);

    await harness.storage.putVersion(
      baseWrite({
        requestId: 'qp-target-chat',
        objectId: 'chat:qp',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );

    for (let i = 0; i < 30; i++) {
      await harness.storage.putVersion(
        baseWrite({
          requestId: `qp-v-${i}`,
          objectId: `toolcall:qp:${i}`,
          objectType: 'toolcall',
          sessionId: i % 2 === 0 ? 'sess-even' : 'sess-odd',
          toolName: i % 3 === 0 ? 'bash' : 'read',
          status: i % 5 === 0 ? 'fail' : 'ok',
          contentStruct: {},
          metadata: {},
        }),
      );
    }

    await harness.storage.putVersion(
      baseWrite({
        requestId: 'qp-session-1',
        objectId: 'session:qp:1',
        objectType: 'session',
        sessionId: 'sess-qp',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:qp', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [{ target_object_id: 'obj:missing', mode: 'dynamic', ref_kind: 'active' }],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    await harness.storage.putVersion(
      baseWrite({
        requestId: 'qp-session-2',
        objectId: 'session:qp:2',
        objectType: 'session',
        sessionId: 'sess-qp',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:qp', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [],
          inactive_set: [],
          pinned_set: [{ target_object_id: 'chat:qp', mode: 'pinned', target_object_hash: 'hash-1', ref_kind: 'pin' }],
        },
        metadata: {},
      }),
    );
  });

  afterEach(async () => {
    inspect.close();
    await cleanupStorageHarness(harness);
  });

  it('uses idx_versions_session_id for session_id lookups', () => {
    const plan = inspect
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM object_versions WHERE session_id = ?')
      .all('sess-even') as Array<{ detail: string }>;

    expect(plan.some((p) => p.detail.includes('idx_versions_session_id'))).toBe(true);
  });

  it('uses idx_refs_target_version / idx_refs_target_hash for reverse lookup filters', async () => {
    const anyPinned = await harness.storage.queryReferences({ mode: 'pinned' });
    expect(anyPinned.length).toBeGreaterThan(0);

    const targetHash = anyPinned[0].targetObjectHash;
    expect(targetHash).toBeTruthy();
    if (!targetHash) throw new Error('expected pinned ref targetObjectHash');

    const planHash = inspect
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM doc_references WHERE target_object_hash = ?')
      .all(targetHash) as Array<{ detail: string }>;

    expect(planHash.some((p) => p.detail.includes('idx_refs_target_hash'))).toBe(true);

    // Ensure target_version_id lookup shape is also index-backed.
    const planVersion = inspect
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM doc_references WHERE target_version_id = ?')
      .all('nonexistent-version') as Array<{ detail: string }>;

    expect(planVersion.some((p) => p.detail.includes('idx_refs_target_version'))).toBe(true);
  });

  it('uses partial unresolved index idx_refs_resolved for unresolved refs query', () => {
    const plan = inspect
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM doc_references WHERE resolved = 0')
      .all() as Array<{ detail: string }>;

    expect(plan.some((p) => p.detail.includes('idx_refs_resolved'))).toBe(true);
  });
});
