import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import type { VersionWriteInput } from '../../src/storage/storage-port.js';

export type StorageHarness = {
  tempDir: string;
  dbPath: string;
  storage: SqliteStorage;
};

export async function createStorageHarness(): Promise<StorageHarness> {
  const tempDir = await mkdtemp(join(tmpdir(), 'self-context-sqlite-'));
  const dbPath = join(tempDir, 'storage.db');
  const storage = new SqliteStorage({ path: dbPath });
  return { tempDir, dbPath, storage };
}

export async function cleanupStorageHarness(harness: StorageHarness): Promise<void> {
  harness.storage.close();
  await rm(harness.tempDir, { recursive: true, force: true });
}

export function openInspectDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);

    if (/^\s*PRAGMA\s+foreign_key_list\(/i.test(sql)) {
      const originalAll = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        const rows = originalAll(...(args as [])) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          table: String(row.table),
          from: String(row.from),
          to: String(row.to),
        }));
      }) as typeof stmt.all;
    }

    return stmt;
  }) as typeof db.prepare;

  return db;
}

export function baseWrite(
  overrides: Partial<VersionWriteInput> & Pick<VersionWriteInput, 'requestId' | 'objectId' | 'objectType'>,
): VersionWriteInput {
  return {
    requestId: overrides.requestId,
    objectId: overrides.objectId,
    objectType: overrides.objectType,

    writerId: overrides.writerId ?? 'test-writer',
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

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
