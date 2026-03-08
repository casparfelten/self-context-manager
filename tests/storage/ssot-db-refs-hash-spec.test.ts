import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import type { VersionWriteInput } from '../../src/storage/storage-port.js';

function writeInput(
  overrides: Partial<VersionWriteInput> & Pick<VersionWriteInput, 'requestId' | 'objectId' | 'objectType'>,
): VersionWriteInput {
  return {
    requestId: overrides.requestId,
    objectId: overrides.objectId,
    objectType: overrides.objectType,
    writerId: overrides.writerId ?? 'tdd',
    writerKind: overrides.writerKind ?? 'client',
    writeReason: overrides.writeReason ?? 'manual',
    contentStruct: overrides.contentStruct ?? {},
    fileBytes: overrides.fileBytes,
    path: overrides.path,
    sessionId: overrides.sessionId,
    toolName: overrides.toolName,
    status: overrides.status,
    charCount: overrides.charCount,
    metadata: overrides.metadata ?? {},
    expectedCurrentVersionId: overrides.expectedCurrentVersionId,
    txTime: overrides.txTime,
  };
}

describe('DB SSOT §6.4 refs_hash conformance', () => {
  let dir = '';
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scm-refs-hash-'));
    storage = new SqliteStorage({ path: join(dir, 'db.sqlite') });

    await storage.putVersion(
      writeInput({
        requestId: 'chat-root',
        objectId: 'chat:spec',
        objectType: 'chat',
        contentStruct: {},
        metadata: {},
      }),
    );

    await storage.putVersion(
      writeInput({
        requestId: 'obj-a',
        objectId: 'obj:a',
        objectType: 'file',
        contentStruct: {},
        metadata: {},
      }),
    );

    await storage.putVersion(
      writeInput({
        requestId: 'obj-b',
        objectId: 'obj:b',
        objectType: 'file',
        contentStruct: {},
        metadata: {},
      }),
    );
  });

  afterEach(async () => {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('excludes ref_metadata from refs_hash tuple', async () => {
    const a = await storage.putVersion(
      writeInput({
        requestId: 'meta-a',
        objectId: 'session:meta-a',
        objectType: 'session',
        sessionId: 'meta',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:spec', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [
            {
              target_object_id: 'obj:a',
              mode: 'dynamic',
              ref_kind: 'active',
              ref_metadata: { a: 1 },
            },
          ],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    const b = await storage.putVersion(
      writeInput({
        requestId: 'meta-b',
        objectId: 'session:meta-b',
        objectType: 'session',
        sessionId: 'meta',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:spec', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [
            {
              target_object_id: 'obj:a',
              mode: 'dynamic',
              ref_kind: 'active',
              ref_metadata: { a: 999, note: 'different metadata only' },
            },
          ],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.record.refsHash).toBe(b.record.refsHash);
  });

  it('uses exact from_path in tuple; array index changes must change refs_hash', async () => {
    const x = await storage.putVersion(
      writeInput({
        requestId: 'order-x',
        objectId: 'session:order-x',
        objectType: 'session',
        sessionId: 'order',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:spec', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [
            { target_object_id: 'obj:a', mode: 'dynamic', ref_kind: 'active' },
            { target_object_id: 'obj:b', mode: 'dynamic', ref_kind: 'active' },
          ],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    const y = await storage.putVersion(
      writeInput({
        requestId: 'order-y',
        objectId: 'session:order-y',
        objectType: 'session',
        sessionId: 'order',
        contentStruct: {
          chat_ref: { target_object_id: 'chat:spec', mode: 'dynamic', ref_kind: 'chat' },
          active_set: [
            { target_object_id: 'obj:b', mode: 'dynamic', ref_kind: 'active' },
            { target_object_id: 'obj:a', mode: 'dynamic', ref_kind: 'active' },
          ],
          inactive_set: [],
          pinned_set: [],
        },
        metadata: {},
      }),
    );

    expect(x.ok).toBe(true);
    expect(y.ok).toBe(true);
    if (!x.ok || !y.ok) return;

    expect(x.record.refsHash).not.toBe(y.record.refsHash);
  });
});
