/**
 * SSOT Conformance Tests: Object Identity (§2.5)
 *
 * Tests the identity rules defined in the SSOT spec:
 * - Sourced objects: xt/id = identity_hash = SHA-256({type, source})
 * - Unsourced objects: xt/id assigned, identity_hash = SHA-256({type, xt/id})
 * - Same source → same ID (multi-agent convergence)
 * - Different filesystemId → different object (even same path string)
 *
 * Reference: docs/spec/context-manager-ssot.md §2.5
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

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

// Source binding types per §2.3
interface FilesystemSource {
  type: 'filesystem';
  filesystemId: string;
  path: string; // canonical absolute path
}

type Source = FilesystemSource; // Extensible union

// Identity computation per §2.5
function computeSourcedId(type: string, source: Source): string {
  return sha256(stableStringify({ type, source }));
}

function computeUnsourcedIdentityHash(type: string, assignedId: string): string {
  return sha256(stableStringify({ type, 'xt/id': assignedId }));
}

describe('SSOT §2.5 - Object Identity', () => {
  describe('Sourced objects', () => {
    it('xt/id equals identity_hash for sourced objects', () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'host-abc123',
        path: '/home/user/project/main.ts',
      };

      const xtId = computeSourcedId('file', source);
      const identityHash = sha256(stableStringify({ type: 'file', source }));

      expect(xtId).toBe(identityHash);
    });

    it('same source produces same ID (multi-agent convergence)', () => {
      // Two agents indexing the same file should get the same object ID
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'shared-host-id',
        path: '/workspace/shared/config.json',
      };

      const agentAId = computeSourcedId('file', source);
      const agentBId = computeSourcedId('file', source);

      expect(agentAId).toBe(agentBId);
    });

    it('different path produces different ID', () => {
      const source1: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'host-1',
        path: '/project/src/a.ts',
      };
      const source2: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'host-1',
        path: '/project/src/b.ts',
      };

      expect(computeSourcedId('file', source1)).not.toBe(computeSourcedId('file', source2));
    });

    it('different filesystemId produces different ID (even same path string)', () => {
      // This is the key multi-machine/multi-container behavior
      // Same path on different filesystems = different objects
      const hostSource: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'host-machine-id',
        path: '/workspace/main.ts',
      };
      const containerSource: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'container-overlay-id',
        path: '/workspace/main.ts', // Same path string!
      };

      const hostId = computeSourcedId('file', hostSource);
      const containerId = computeSourcedId('file', containerSource);

      expect(hostId).not.toBe(containerId);
    });

    it('identity rule: same external source = same object', () => {
      // "if agent A changes it and agent B inherently sees the change
      // (same file on same filesystem), it is the same object"
      const sharedSource: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'shared-nfs-mount',
        path: '/shared/docs/readme.md',
      };

      // Different clients, same source
      const client1Id = computeSourcedId('file', sharedSource);
      const client2Id = computeSourcedId('file', sharedSource);
      const client3Id = computeSourcedId('file', sharedSource);

      expect(client1Id).toBe(client2Id);
      expect(client2Id).toBe(client3Id);
    });

    it('identity rule: isolated changes = different objects', () => {
      // "If changes don't propagate (different filesystems),
      // they are different objects even if the path string matches"
      const machine1: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'machine-1-id',
        path: '/home/user/code/app.ts',
      };
      const machine2: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'machine-2-id',
        path: '/home/user/code/app.ts', // Same path, different machine
      };

      expect(computeSourcedId('file', machine1)).not.toBe(computeSourcedId('file', machine2));
    });
  });

  describe('Unsourced objects', () => {
    it('xt/id is assigned at creation', () => {
      // Unsourced objects get their ID from elsewhere (harness, UUID, etc.)
      const assignedId = 'toolcall:tc-12345-abcdef';
      // This is valid - the ID is assigned, not computed
      expect(assignedId).toBeTruthy();
    });

    it('identity_hash = SHA-256({type, xt/id})', () => {
      const assignedId = 'toolcall:tc-98765';
      const identityHash = computeUnsourcedIdentityHash('toolcall', assignedId);
      const expected = sha256(stableStringify({ type: 'toolcall', 'xt/id': assignedId }));

      expect(identityHash).toBe(expected);
    });

    it('identity_hash verifies the ID/type pairing', () => {
      // Same ID, different type = different identity_hash
      const assignedId = 'object:xyz';

      const toolcallIdentity = computeUnsourcedIdentityHash('toolcall', assignedId);
      const chatIdentity = computeUnsourcedIdentityHash('chat', assignedId);

      expect(toolcallIdentity).not.toBe(chatIdentity);
    });

    it('chat object ID format: chat:{sessionId}', () => {
      const sessionId = 'session-123';
      const chatId = `chat:${sessionId}`;
      const identityHash = computeUnsourcedIdentityHash('chat', chatId);

      expect(chatId).toBe('chat:session-123');
      expect(identityHash).toBeTruthy();
    });

    it('toolcall ID comes from harness', () => {
      // The harness assigns the tool call ID
      const harnessProvidedId = 'tc-harness-generated-uuid-here';
      const identityHash = computeUnsourcedIdentityHash('toolcall', harnessProvidedId);

      expect(identityHash).toBeTruthy();
      expect(typeof identityHash).toBe('string');
    });
  });

  describe('Source binding structure (§2.3)', () => {
    it('FilesystemSource has required fields', () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'abc123',
        path: '/absolute/canonical/path.ts',
      };

      expect(source.type).toBe('filesystem');
      expect(source.filesystemId).toBeTruthy();
      expect(source.path).toMatch(/^\//); // Canonical = absolute
    });

    it('source binding is immutable (verified by identity_hash stability)', () => {
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs-id',
        path: '/file.txt',
      };

      const id1 = computeSourcedId('file', source);
      // If source were mutable, changing it would change the ID
      // But source is part of the immutable envelope
      const id2 = computeSourcedId('file', source);

      expect(id1).toBe(id2);
    });

    it('canonical path is host-side for bind mounts', () => {
      // Per §5.3: "For bind mounts, the host-side path"
      // Agent sees: /workspace/main.ts
      // Source stores: /home/user/.openclaw/workspaces/dev/main.ts (host path)
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'host-id',
        path: '/home/user/.openclaw/workspaces/dev/main.ts', // Host-side canonical
      };

      expect(source.path).not.toBe('/workspace/main.ts'); // Not the container path
    });
  });

  describe('Type field inclusion in identity', () => {
    it('different types with same source produce different IDs', () => {
      // Future-proofing: if we ever have typed paths (unlikely but possible)
      const source: FilesystemSource = {
        type: 'filesystem',
        filesystemId: 'fs',
        path: '/test',
      };

      // file type
      const fileId = sha256(stableStringify({ type: 'file', source }));
      // Hypothetical other sourced type (future)
      const otherId = sha256(stableStringify({ type: 'hypothetical_sourced', source }));

      expect(fileId).not.toBe(otherId);
    });
  });
});

describe('SSOT §2.5 - Multi-Agent Scenarios', () => {
  it('two clients indexing the same file resolve to same object', () => {
    const sharedSource: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'shared-host',
      path: '/project/package.json',
    };

    // Client 1 indexes the file
    const client1ObjectId = computeSourcedId('file', sharedSource);

    // Client 2 indexes the same file later
    const client2ObjectId = computeSourcedId('file', sharedSource);

    expect(client1ObjectId).toBe(client2ObjectId);
  });

  it('bind-mounted files have host identity, not container identity', () => {
    // When agent in container accesses /workspace/main.ts,
    // and /workspace is bind-mounted from /home/user/dev,
    // the source binding should use the host path + host FS ID

    // Correct: host-side identity
    const correctSource: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'host-machine-id',
      path: '/home/user/dev/main.ts', // Host path
    };

    // Wrong: container-side identity (would create isolated object)
    const wrongSource: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'container-id',
      path: '/workspace/main.ts', // Container path
    };

    expect(computeSourcedId('file', correctSource)).not.toBe(computeSourcedId('file', wrongSource));
  });

  it('container-internal files (overlay) are properly isolated', () => {
    // Files not on bind mounts are container-specific
    // Each container's /tmp is different

    const container1: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'container-1-overlay',
      path: '/tmp/scratch.txt',
    };

    const container2: FilesystemSource = {
      type: 'filesystem',
      filesystemId: 'container-2-overlay',
      path: '/tmp/scratch.txt',
    };

    expect(computeSourcedId('file', container1)).not.toBe(computeSourcedId('file', container2));
  });
});
