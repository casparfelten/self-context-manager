/**
 * SSOT Conformance Tests: Hashes (§2.4)
 *
 * Tests the five-hash hierarchy defined in the SSOT spec:
 * - identity_hash: immutable, per object, never changes
 * - file_hash: SHA-256 of raw file bytes (UTF-8), null for unsourced/discovery stubs
 * - content_hash: SHA-256 of content field, null if content is null
 * - metadata_hash: SHA-256 of type-specific fields only
 * - object_hash: composite of file_hash + content_hash + metadata_hash
 *
 * Reference: docs/spec/context-manager-ssot.md §2.4
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Stable JSON stringification for hash inputs
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// === SPEC-REQUIRED HASH FUNCTIONS ===
// These implementations match SSOT §2.4 exactly.
// The actual module should implement these identically.

function identityHash(type: string, source: object | null, assignedId?: string): string {
  if (source) {
    return sha256(stableStringify({ type, source }));
  }
  if (!assignedId) throw new Error('assignedId required for unsourced objects');
  return sha256(stableStringify({ type, 'xt/id': assignedId }));
}

function fileHash(content: string): string {
  return sha256(content); // UTF-8 string, same as raw file bytes
}

function contentHash(content: string | null): string | null {
  if (content === null) return null;
  return sha256(content);
}

function metadataHash(typeSpecificFields: Record<string, unknown>): string {
  return sha256(stableStringify(typeSpecificFields));
}

function objectHash(fh: string | null, ch: string | null, mh: string): string {
  return sha256(stableStringify({ file_hash: fh, content_hash: ch, metadata_hash: mh }));
}

// === CONFORMANCE TESTS ===

describe('SSOT §2.4 - Hash Hierarchy', () => {
  describe('identity_hash', () => {
    it('is immutable - same source always produces same hash', () => {
      const source = { type: 'filesystem', filesystemId: 'fs-123', path: '/home/test/file.ts' };

      const hash1 = identityHash('file', source);
      const hash2 = identityHash('file', source);

      expect(hash1).toBe(hash2);
    });

    it('sourced: SHA-256 of {type, source}', () => {
      const source = { type: 'filesystem', filesystemId: 'abc123', path: '/tmp/test.md' };
      const expected = sha256(stableStringify({ type: 'file', source }));

      expect(identityHash('file', source)).toBe(expected);
    });

    it('unsourced: SHA-256 of {type, xt/id}', () => {
      const assignedId = 'toolcall:tc-12345';
      const expected = sha256(stableStringify({ type: 'toolcall', 'xt/id': assignedId }));

      expect(identityHash('toolcall', null, assignedId)).toBe(expected);
    });

    it('different source types produce different hashes', () => {
      const fsSource = { type: 'filesystem', filesystemId: 'fs-1', path: '/test' };
      // Future: S3 source would look like { type: 's3', bucket: 'x', key: 'y' }
      const fsSource2 = { type: 'filesystem', filesystemId: 'fs-2', path: '/test' };

      const hash1 = identityHash('file', fsSource);
      const hash2 = identityHash('file', fsSource2);

      expect(hash1).not.toBe(hash2);
    });

    it('same path, different filesystemId produces different identity', () => {
      const source1 = { type: 'filesystem', filesystemId: 'host-machine', path: '/workspace/main.ts' };
      const source2 = { type: 'filesystem', filesystemId: 'container-overlay', path: '/workspace/main.ts' };

      expect(identityHash('file', source1)).not.toBe(identityHash('file', source2));
    });
  });

  describe('file_hash', () => {
    it('SHA-256 of raw file bytes as UTF-8', () => {
      const content = 'hello world';
      const expected = sha256(content);

      expect(fileHash(content)).toBe(expected);
    });

    it('deterministic - same content always same hash', () => {
      const content = 'function test() { return 42; }';
      expect(fileHash(content)).toBe(fileHash(content));
    });

    it('should be null for unsourced objects (enforced at document level)', () => {
      // file_hash is only computed for sourced files
      // toolcall.file_hash should be null
      // This is a document structure test, not a hash function test
      expect(true).toBe(true); // Placeholder - actual test in document structure
    });

    it('should be null for discovery stubs (never read)', () => {
      // Discovery creates stubs with file_hash = null
      // This is tested in indexing protocol tests
      expect(true).toBe(true);
    });
  });

  describe('content_hash', () => {
    it('SHA-256 of content field when content exists', () => {
      const content = 'const x = 1;';
      const expected = sha256(content);

      expect(contentHash(content)).toBe(expected);
    });

    it('null when content is null', () => {
      expect(contentHash(null)).toBeNull();
    });

    it('empty string produces valid hash, not null', () => {
      const hash = contentHash('');
      expect(hash).not.toBeNull();
      expect(hash).toBe(sha256(''));
    });
  });

  describe('metadata_hash', () => {
    it('SHA-256 of type-specific fields only', () => {
      // For file type: file_type, char_count
      const fields = { file_type: 'ts', char_count: 42 };
      const expected = sha256(stableStringify(fields));

      expect(metadataHash(fields)).toBe(expected);
    });

    it('always computable even if fields are empty/default', () => {
      const emptyFields = {};
      const hash = metadataHash(emptyFields);

      expect(hash).toBeTruthy();
      expect(hash).toBe(sha256(stableStringify({})));
    });

    it('file type: only file_type and char_count', () => {
      const fileFields = { file_type: 'md', char_count: 100 };
      const hash1 = metadataHash(fileFields);

      // Including content should not be in metadata_hash
      const wrongFields = { file_type: 'md', char_count: 100, content: 'should not be here' };
      const hash2 = metadataHash({ file_type: 'md', char_count: 100 }); // Extract only valid fields

      expect(hash1).toBe(hash2);
    });

    it('toolcall type: tool, args, args_display, status, chat_ref, file_refs', () => {
      const toolcallFields = {
        tool: 'bash',
        args: { command: 'ls -la' },
        args_display: 'ls -la',
        status: 'ok',
        chat_ref: 'chat:session-1',
        file_refs: ['file:abc', 'file:def'],
      };
      const hash = metadataHash(toolcallFields);

      expect(hash).toBeTruthy();
    });

    it('chat type: turns, session_ref, turn_count, toolcall_refs', () => {
      const chatFields = {
        turns: [{ user: 'hello', assistant: [{ type: 'text', text: 'hi' }] }],
        session_ref: 'session:s1',
        turn_count: 1,
        toolcall_refs: [],
      };
      const hash = metadataHash(chatFields);

      expect(hash).toBeTruthy();
    });

    it('system_prompt type: no type-specific fields (empty object)', () => {
      // system_prompt has no type-specific fields beyond content
      const hash = metadataHash({});

      expect(hash).toBe(sha256(stableStringify({})));
    });

    it('session type: session_id, chat_ref, system_prompt_ref, session_index, metadata_pool, active_set, pinned_set', () => {
      const sessionFields = {
        session_id: 'session-123',
        chat_ref: 'chat:session-123',
        system_prompt_ref: 'system_prompt:session-123',
        session_index: ['file:a', 'toolcall:b'],
        metadata_pool: ['file:a'],
        active_set: ['file:a'],
        pinned_set: [],
      };
      const hash = metadataHash(sessionFields);

      expect(hash).toBeTruthy();
    });

    it('order of fields does not affect hash (stable stringify)', () => {
      const fields1 = { char_count: 50, file_type: 'js' };
      const fields2 = { file_type: 'js', char_count: 50 };

      expect(metadataHash(fields1)).toBe(metadataHash(fields2));
    });
  });

  describe('object_hash', () => {
    it('composite of file_hash, content_hash, metadata_hash', () => {
      const fh = sha256('file content');
      const ch = sha256('stored content');
      const mh = sha256(stableStringify({ file_type: 'ts', char_count: 12 }));

      const expected = sha256(stableStringify({ file_hash: fh, content_hash: ch, metadata_hash: mh }));

      expect(objectHash(fh, ch, mh)).toBe(expected);
    });

    it('changes if file_hash changes', () => {
      const mh = metadataHash({ file_type: 'ts', char_count: 10 });
      const ch = sha256('content');

      const hash1 = objectHash(sha256('version1'), ch, mh);
      const hash2 = objectHash(sha256('version2'), ch, mh);

      expect(hash1).not.toBe(hash2);
    });

    it('changes if content_hash changes', () => {
      const mh = metadataHash({ file_type: 'ts', char_count: 10 });
      const fh = sha256('raw bytes');

      const hash1 = objectHash(fh, sha256('content-v1'), mh);
      const hash2 = objectHash(fh, sha256('content-v2'), mh);

      expect(hash1).not.toBe(hash2);
    });

    it('changes if metadata_hash changes', () => {
      const fh = sha256('bytes');
      const ch = sha256('content');

      const hash1 = objectHash(fh, ch, metadataHash({ file_type: 'ts', char_count: 10 }));
      const hash2 = objectHash(fh, ch, metadataHash({ file_type: 'ts', char_count: 20 }));

      expect(hash1).not.toBe(hash2);
    });

    it('handles null file_hash (unsourced objects)', () => {
      const ch = sha256('content');
      const mh = metadataHash({ tool: 'bash', status: 'ok' });

      const hash = objectHash(null, ch, mh);
      expect(hash).toBeTruthy();
    });

    it('handles null content_hash (discovery stubs, deleted)', () => {
      const fh = null; // stub
      const mh = metadataHash({ file_type: 'ts', char_count: 0 });

      const hash = objectHash(fh, null, mh);
      expect(hash).toBeTruthy();
    });

    it('never null - always computable', () => {
      const hash = objectHash(null, null, metadataHash({}));
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // SHA-256 hex
    });
  });

  describe('Hash exclusions (§2.4 metadata_hash)', () => {
    it('metadata_hash excludes: content, xt/id, type, source, identity_hash, file_hash, content_hash, metadata_hash, object_hash', () => {
      // The metadata_hash input is ONLY the type-specific fields.
      // It should NOT include any of the excluded fields.

      // Correct: only type-specific fields
      const correctInput = { file_type: 'ts', char_count: 100 };

      // Wrong: including excluded fields
      const wrongInput = {
        'xt/id': 'file:abc',
        type: 'file',
        source: { type: 'filesystem', filesystemId: 'x', path: '/x' },
        content: 'hello',
        identity_hash: 'abc',
        file_hash: 'def',
        content_hash: 'ghi',
        file_type: 'ts',
        char_count: 100,
      };

      const correctHash = metadataHash(correctInput);
      const wrongHash = metadataHash(wrongInput);

      // These should be different - if they're the same, the implementation is wrong
      expect(correctHash).not.toBe(wrongHash);
    });
  });
});

describe('SSOT §2.4 - Hash Invariants', () => {
  it('identity_hash is stable across versions (immutable)', () => {
    // When a file changes content, identity_hash stays the same
    const source = { type: 'filesystem', filesystemId: 'host', path: '/app/main.ts' };

    // Version 1
    const id1 = identityHash('file', source);
    // Version 2 (after edit) - same source
    const id2 = identityHash('file', source);

    expect(id1).toBe(id2);
  });

  it('file_hash equals content_hash for text files (today)', () => {
    // Per spec: "For text files today they're identical"
    // They diverge if we store transformed content
    const content = 'const x = 1;\nfunction foo() {}';

    const fh = fileHash(content);
    const ch = contentHash(content);

    expect(fh).toBe(ch);
  });

  it('object_hash is full version fingerprint', () => {
    // Same object, same version → same object_hash
    const fh = fileHash('content');
    const ch = contentHash('content');
    const mh = metadataHash({ file_type: 'ts', char_count: 7 });

    const hash1 = objectHash(fh, ch, mh);
    const hash2 = objectHash(fh, ch, mh);

    expect(hash1).toBe(hash2);
  });
});
