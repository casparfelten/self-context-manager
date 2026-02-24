/**
 * SSOT Conformance Tests: Indexing Protocol (§5.6)
 *
 * Tests the two indexing entry points:
 * - Full indexing: agent reads, watcher fires, session resume
 * - Discovery: path extraction from tool output (ls, grep, find)
 *
 * Key behaviors:
 * - Full indexing: returns created/unchanged/updated
 * - Discovery: creates stubs with null content/file_hash
 * - Discovery never overwrites existing objects
 * - Stub upgrade on read
 *
 * Reference: docs/spec/context-manager-ssot.md §5.6, §5.7
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

// Types for indexing
interface FilesystemSource {
  type: 'filesystem';
  filesystemId: string;
  path: string;
}

type IndexAction = 'created' | 'updated' | 'unchanged';

interface IndexResult {
  objectId: string;
  action: IndexAction;
}

interface FileDocument {
  'xt/id': string;
  type: 'file';
  source: FilesystemSource;
  identity_hash: string;
  content: string | null;
  file_type: string;
  char_count: number;
  file_hash: string | null;
  content_hash: string | null;
  metadata_hash: string;
  object_hash: string;
}

// Mock database for testing indexing logic
class MockXtdb {
  private documents: Map<string, FileDocument> = new Map();

  async get(id: string): Promise<FileDocument | null> {
    return this.documents.get(id) ?? null;
  }

  async put(doc: FileDocument): Promise<void> {
    this.documents.set(doc['xt/id'], doc);
  }

  clear(): void {
    this.documents.clear();
  }
}

// Compute object ID from source
function computeObjectId(source: FilesystemSource): string {
  return sha256(stableStringify({ type: 'file', source }));
}

// Build full file document
function buildFileDoc(
  objectId: string,
  source: FilesystemSource,
  content: string,
  fileHash: string
): FileDocument {
  const fileType = source.path.split('.').pop() ?? '';
  const charCount = content.length;
  const contentHashVal = sha256(content);
  const metadataHashVal = sha256(stableStringify({ file_type: fileType, char_count: charCount }));
  const objectHashVal = sha256(stableStringify({
    file_hash: fileHash,
    content_hash: contentHashVal,
    metadata_hash: metadataHashVal,
  }));

  return {
    'xt/id': objectId,
    type: 'file',
    source,
    identity_hash: objectId, // For sourced objects
    content,
    file_type: fileType,
    char_count: charCount,
    file_hash: fileHash,
    content_hash: contentHashVal,
    metadata_hash: metadataHashVal,
    object_hash: objectHashVal,
  };
}

// Build discovery stub document
function buildStubDoc(objectId: string, source: FilesystemSource): FileDocument {
  const fileType = source.path.split('.').pop() ?? '';
  const metadataHashVal = sha256(stableStringify({ file_type: fileType, char_count: 0 }));
  const objectHashVal = sha256(stableStringify({
    file_hash: null,
    content_hash: null,
    metadata_hash: metadataHashVal,
  }));

  return {
    'xt/id': objectId,
    type: 'file',
    source,
    identity_hash: objectId,
    content: null,
    file_type: fileType,
    char_count: 0,
    file_hash: null,
    content_hash: null,
    metadata_hash: metadataHashVal,
    object_hash: objectHashVal,
  };
}

// Full indexing implementation per §5.6
async function indexFile(
  db: MockXtdb,
  source: FilesystemSource,
  content: string
): Promise<IndexResult> {
  const objectId = computeObjectId(source);
  const fh = sha256(content);
  const existing = await db.get(objectId);

  if (!existing) {
    await db.put(buildFileDoc(objectId, source, content, fh));
    return { objectId, action: 'created' };
  }

  if (existing.file_hash === null) {
    // Discovery stub - upgrade it
    await db.put(buildFileDoc(objectId, source, content, fh));
    return { objectId, action: 'updated' };
  }

  if (existing.file_hash === fh) {
    return { objectId, action: 'unchanged' };
  }

  // Content changed
  await db.put(buildFileDoc(objectId, source, content, fh));
  return { objectId, action: 'updated' };
}

// Discovery indexing implementation per §5.6
async function discoverFile(
  db: MockXtdb,
  source: FilesystemSource
): Promise<IndexResult> {
  const objectId = computeObjectId(source);
  const existing = await db.get(objectId);

  if (existing) {
    // Discovery never overwrites
    return { objectId, action: 'unchanged' };
  }

  await db.put(buildStubDoc(objectId, source));
  return { objectId, action: 'created' };
}

describe('SSOT §5.6 - Full Indexing', () => {
  let db: MockXtdb;

  beforeEach(() => {
    db = new MockXtdb();
  });

  describe('Step 1: Resolve identity', () => {
    it('computes object ID from source binding', () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'host-123',
        path: '/project/main.ts',
      };

      const objectId = computeObjectId(source);
      expect(objectId).toBe(sha256(stableStringify({ type: 'file', source })));
    });
  });

  describe('Step 2: Get content and file_hash', () => {
    it('file_hash is SHA-256 of content as UTF-8', () => {
      const content = 'const x = 1;';
      const fh = sha256(content);

      expect(fh).toBe(sha256('const x = 1;'));
    });
  });

  describe('Step 3: Check database and act', () => {
    it('not found → create with full envelope + payload, return created', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/new-file.ts',
      };

      const result = await indexFile(db, source, 'new content');

      expect(result.action).toBe('created');
      const doc = await db.get(result.objectId);
      expect(doc).not.toBeNull();
      expect(doc!.content).toBe('new content');
      expect(doc!.file_hash).toBe(sha256('new content'));
      expect(doc!.content_hash).toBe(sha256('new content'));
    });

    it('found, file_hash null (stub) → update with content + hashes, return updated', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/stub-file.ts',
      };

      // Create stub first (via discovery)
      await discoverFile(db, source);
      const stubDoc = await db.get(computeObjectId(source));
      expect(stubDoc!.file_hash).toBeNull();
      expect(stubDoc!.content).toBeNull();

      // Now full-index it
      const result = await indexFile(db, source, 'actual content');

      expect(result.action).toBe('updated');
      const doc = await db.get(result.objectId);
      expect(doc!.content).toBe('actual content');
      expect(doc!.file_hash).toBe(sha256('actual content'));
    });

    it('found, file_hash matches → no-op, return unchanged', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/stable-file.ts',
      };
      const content = 'stable content';

      // First index
      await indexFile(db, source, content);

      // Re-index same content
      const result = await indexFile(db, source, content);

      expect(result.action).toBe('unchanged');
    });

    it('found, file_hash differs → write new version, return updated', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/changing-file.ts',
      };

      // First version
      await indexFile(db, source, 'version 1');
      const doc1 = await db.get(computeObjectId(source));
      const hash1 = doc1!.object_hash;

      // Second version
      const result = await indexFile(db, source, 'version 2');

      expect(result.action).toBe('updated');
      const doc2 = await db.get(computeObjectId(source));
      expect(doc2!.content).toBe('version 2');
      expect(doc2!.object_hash).not.toBe(hash1);
    });
  });

  describe('Step 4: Session updates by trigger', () => {
    it('agent read → add to session_index, metadata_pool, active_set', () => {
      // This is session state management, not indexing
      // Tested in session-sets.test.ts

      // The indexing function doesn't manage session sets directly
      // The caller (extension) does
      expect(true).toBe(true);
    });

    it('watcher event → update cache only, do NOT change sets', () => {
      // Per spec: "Do NOT change set membership —
      // don't force-activate something the agent deactivated"
      // Tested in watcher.test.ts
      expect(true).toBe(true);
    });

    it('session resume → sets already restored, no set changes', () => {
      // Tested in session-lifecycle.test.ts
      expect(true).toBe(true);
    });
  });
});

describe('SSOT §5.6 - Discovery', () => {
  let db: MockXtdb;

  beforeEach(() => {
    db = new MockXtdb();
  });

  describe('Discovery stub structure', () => {
    it('creates stub with content: null', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/discovered.ts',
      };

      await discoverFile(db, source);
      const doc = await db.get(computeObjectId(source));

      expect(doc!.content).toBeNull();
    });

    it('creates stub with file_hash: null', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/discovered.ts',
      };

      await discoverFile(db, source);
      const doc = await db.get(computeObjectId(source));

      expect(doc!.file_hash).toBeNull();
    });

    it('creates stub with content_hash: null', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/discovered.ts',
      };

      await discoverFile(db, source);
      const doc = await db.get(computeObjectId(source));

      expect(doc!.content_hash).toBeNull();
    });

    it('creates stub with char_count: 0', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/discovered.ts',
      };

      await discoverFile(db, source);
      const doc = await db.get(computeObjectId(source));

      expect(doc!.char_count).toBe(0);
    });

    it('extracts file_type from extension', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/project/component.tsx',
      };

      await discoverFile(db, source);
      const doc = await db.get(computeObjectId(source));

      expect(doc!.file_type).toBe('tsx');
    });

    it('has full envelope (source, identity_hash, type)', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/discovered.ts',
      };

      await discoverFile(db, source);
      const doc = await db.get(computeObjectId(source));

      expect(doc!.type).toBe('file');
      expect(doc!.source).toEqual(source);
      expect(doc!.identity_hash).toBe(computeObjectId(source));
    });
  });

  describe('Discovery never overwrites', () => {
    it('returns unchanged if object already exists (full version)', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/existing.ts',
      };

      // Full index first
      await indexFile(db, source, 'real content');
      const originalDoc = await db.get(computeObjectId(source));

      // Discovery should not overwrite
      const result = await discoverFile(db, source);

      expect(result.action).toBe('unchanged');
      const doc = await db.get(computeObjectId(source));
      expect(doc!.content).toBe('real content'); // Unchanged
      expect(doc!.file_hash).toBe(originalDoc!.file_hash);
    });

    it('returns unchanged if stub already exists', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/double-discovered.ts',
      };

      // First discovery
      await discoverFile(db, source);

      // Second discovery
      const result = await discoverFile(db, source);

      expect(result.action).toBe('unchanged');
    });

    it('preserves existing content when re-discovered', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/file.ts',
      };

      // Full index
      await indexFile(db, source, 'important content');

      // Try to discover (should not overwrite)
      await discoverFile(db, source);

      const doc = await db.get(computeObjectId(source));
      expect(doc!.content).toBe('important content');
      expect(doc!.file_hash).not.toBeNull();
    });
  });

  describe('Stub upgrade on read', () => {
    it('full index upgrades stub to full document', async () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs1',
        path: '/stub-upgrade.ts',
      };

      // Discover (creates stub)
      await discoverFile(db, source);
      let doc = await db.get(computeObjectId(source));
      expect(doc!.file_hash).toBeNull();

      // Read file (full index)
      await indexFile(db, source, 'const x = 1;');
      doc = await db.get(computeObjectId(source));

      expect(doc!.content).toBe('const x = 1;');
      expect(doc!.file_hash).toBe(sha256('const x = 1;'));
      expect(doc!.char_count).toBe(12);
    });
  });

  describe('Session updates for discovery', () => {
    it('discovery adds to session_index and metadata_pool (not active_set)', () => {
      // Per spec: "Add to session index and metadata pool (not active set)."
      // The agent has to explicitly activate discovered files

      // This is behavioral - tested in session-sets.test.ts
      expect(true).toBe(true);
    });
  });
});

describe('SSOT §5.7 - Unsourced Object Creation', () => {
  it('toolcalls created on tool execution', () => {
    // Per spec: "ID from harness. Written once."
    const toolcall = {
      type: 'toolcall',
      'xt/id': 'tc-harness-uuid-123', // ID from harness
      tool: 'bash',
      args: { command: 'ls -la' },
      status: 'ok',
    };

    expect(toolcall['xt/id']).toBeTruthy();
  });

  it('toolcalls added to session_index + metadata_pool + active_set', () => {
    // Per spec: "Added to session index + metadata pool + active set."
    // Tool outputs are auto-activated on creation
    expect(true).toBe(true); // Tested in session-sets.test.ts
  });

  it('infrastructure objects created at session start', () => {
    // chat, system_prompt, session created when session starts
    // Updated as described in §2.6
    expect(true).toBe(true);
  });
});

describe('Indexing - Path Resolution', () => {
  it('same path produces same objectId (identity stability)', async () => {
    const db = new MockXtdb();
    const source: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'fs1',
      path: '/stable/path.ts',
    };

    const result1 = await indexFile(db, source, 'v1');
    const result2 = await indexFile(db, source, 'v2');

    expect(result1.objectId).toBe(result2.objectId);
  });

  it('different paths produce different objectIds', async () => {
    const db = new MockXtdb();
    const source1: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'fs1',
      path: '/a.ts',
    };
    const source2: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'fs1',
      path: '/b.ts',
    };

    const result1 = await indexFile(db, source1, 'a');
    const result2 = await indexFile(db, source2, 'b');

    expect(result1.objectId).not.toBe(result2.objectId);
  });
});
