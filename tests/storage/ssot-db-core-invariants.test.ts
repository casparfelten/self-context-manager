import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  baseWrite,
  cleanupStorageHarness,
  createStorageHarness,
  openInspectDb,
  stableStringify,
  type StorageHarness,
} from './test-helpers.js';

describe('DB SSOT §2 core invariants', () => {
  let harness: StorageHarness;
  let inspect: DatabaseSync;

  beforeEach(async () => {
    harness = await createStorageHarness();
    inspect = openInspectDb(harness.dbPath);
  });

  afterEach(async () => {
    inspect.close();
    await cleanupStorageHarness(harness);
  });

  it('§2.1 object identity: object_id is stable across versions', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-1-a',
        objectId: 'file:/src/a.ts',
        objectType: 'file',
        contentStruct: { v: 1 },
        metadata: {},
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-1-b',
        objectId: 'file:/src/a.ts',
        objectType: 'file',
        expectedCurrentVersionId: first.record.versionId,
        contentStruct: { v: 2 },
        metadata: {},
      }),
    );
    expect(second.ok).toBe(true);

    const history = await harness.storage.getHistory('file:/src/a.ts', 'asc');
    expect(history.map((h) => h.objectId)).toEqual(['file:/src/a.ts', 'file:/src/a.ts']);
  });

  it('§2.2 immutability: older object_versions row is unchanged after new version append', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-2-a',
        objectId: 'file:/immutable.ts',
        objectType: 'file',
        contentStruct: { body: 'first' },
        metadata: { k: 1 },
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const firstRowBefore = inspect
      .prepare('SELECT * FROM object_versions WHERE version_id = ?')
      .get(first.record.versionId) as Record<string, unknown>;

    await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-2-b',
        objectId: 'file:/immutable.ts',
        objectType: 'file',
        expectedCurrentVersionId: first.record.versionId,
        contentStruct: { body: 'second' },
        metadata: { k: 2 },
      }),
    );

    const firstRowAfter = inspect
      .prepare('SELECT * FROM object_versions WHERE version_id = ?')
      .get(first.record.versionId) as Record<string, unknown>;

    expect(firstRowAfter).toEqual(firstRowBefore);
  });

  it('§2.3 version_no is strictly increasing per object', async () => {
    const a = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-3-a',
        objectId: 'file:/v.ts',
        objectType: 'file',
        contentStruct: { v: 'a' },
        metadata: {},
      }),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-3-b',
        objectId: 'file:/v.ts',
        objectType: 'file',
        expectedCurrentVersionId: a.record.versionId,
        contentStruct: { v: 'b' },
        metadata: {},
      }),
    );
    expect(b.ok).toBe(true);

    const history = await harness.storage.getHistory('file:/v.ts', 'asc');
    expect(history.map((h) => h.versionNo)).toEqual([1, 2]);
  });

  it('§2.4 tx_seq is strictly increasing globally', async () => {
    const a = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-4-a',
        objectId: 'obj:a',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );
    const b = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-4-b',
        objectId: 'obj:b',
        objectType: 'toolcall',
        contentStruct: {},
        metadata: {},
      }),
    );

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.record.txSeq).toBeLessThan(b.record.txSeq);
  });

  it('§2.5 single HEAD: objects.current_version_id points to exactly one latest version', async () => {
    const first = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-5-a',
        objectId: 'file:/head.ts',
        objectType: 'file',
        contentStruct: { body: '1' },
        metadata: {},
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-5-b',
        objectId: 'file:/head.ts',
        objectType: 'file',
        expectedCurrentVersionId: first.record.versionId,
        contentStruct: { body: '2' },
        metadata: {},
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const objectRow = inspect
      .prepare('SELECT current_version_id FROM objects WHERE object_id = ?')
      .get('file:/head.ts') as { current_version_id: string };

    expect(objectRow.current_version_id).toBe(second.record.versionId);

    const latest = await harness.storage.getLatest('file:/head.ts');
    expect(latest?.versionId).toBe(second.record.versionId);
  });

  it('§2.6 typed envelope fields are canonical and contradiction is rejected', async () => {
    const ok = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-6-ok',
        objectId: 'toolcall:env',
        objectType: 'toolcall',
        path: '/x.sh',
        sessionId: 'sess-1',
        toolName: 'bash',
        status: 'ok',
        charCount: 9,
        contentStruct: {
          path: '/x.sh',
          session_id: 'sess-1',
          tool_name: 'bash',
          status: 'ok',
          char_count: 9,
        },
        metadata: {},
      }),
    );

    expect(ok.ok).toBe(true);
    if (!ok.ok) return;

    const row = inspect
      .prepare('SELECT path, session_id, tool_name, status, char_count FROM object_versions WHERE version_id = ?')
      .get(ok.record.versionId) as {
      path: string;
      session_id: string;
      tool_name: string;
      status: string;
      char_count: number;
    };

    expect(row).toEqual({
      path: '/x.sh',
      session_id: 'sess-1',
      tool_name: 'bash',
      status: 'ok',
      char_count: 9,
    });

    await expect(
      harness.storage.putVersion(
        baseWrite({
          requestId: 'inv-2-6-bad',
          objectId: 'toolcall:env-2',
          objectType: 'toolcall',
          path: '/a',
          contentStruct: { path: '/b' },
          metadata: {},
        }),
      ),
    ).rejects.toThrow('typed_envelope_mismatch:path');
  });

  it('§2.7 content_struct_json stores canonical semantic payload', async () => {
    const payload = {
      z: 1,
      a: { y: 2, x: 1 },
      list: [{ b: 2, a: 1 }],
    };

    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-7',
        objectId: 'file:/payload.ts',
        objectType: 'file',
        contentStruct: payload,
        metadata: {},
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = inspect
      .prepare('SELECT content_struct_json FROM object_versions WHERE version_id = ?')
      .get(result.record.versionId) as { content_struct_json: string };

    expect(row.content_struct_json).toBe(stableStringify(payload));
  });

  it('§2.8 metadata_json is persisted auxiliary payload', async () => {
    const metadata = { source: 'watcher', tags: ['a', 'b'], nested: { x: 1 } };

    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-8',
        objectId: 'file:/meta.ts',
        objectType: 'file',
        contentStruct: { body: 'x' },
        metadata,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = inspect
      .prepare('SELECT metadata_json FROM object_versions WHERE version_id = ?')
      .get(result.record.versionId) as { metadata_json: string };

    expect(row.metadata_json).toBe(stableStringify(metadata));
  });

  it('§2.9 references are derived only from explicit structured refs in content_struct_json', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-9',
        objectId: 'file:/no-refs.txt',
        objectType: 'file',
        contentStruct: {
          note: 'target_object_id=file:123 mode=pinned target_version_id=v1 (plain text only)',
          nested: { target_object_id: 'file:123', mode: 'dynamic' },
        },
        metadata: {},
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const refs = await harness.storage.queryReferences({ fromVersionId: result.record.versionId });
    expect(refs).toHaveLength(0);
  });

  it('§2.10 missing targets do not reject writes and are stored unresolved', async () => {
    const result = await harness.storage.putVersion(
      baseWrite({
        requestId: 'inv-2-10',
        objectId: 'session:inv',
        objectType: 'session',
        sessionId: 'inv',
        contentStruct: {
          chat_ref: {
            target_object_id: 'chat:missing',
            mode: 'dynamic',
            ref_kind: 'chat',
          },
          active_set: [],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const refs = await harness.storage.queryReferences({ fromVersionId: result.record.versionId });
    expect(refs).toHaveLength(1);
    expect(refs[0].targetObjectId).toBe('chat:missing');
    expect(refs[0].resolved).toBe(false);
  });
});
