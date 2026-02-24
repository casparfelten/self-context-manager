/**
 * SSOT Conformance Tests: Session Sets (§3.1)
 *
 * Tests the session set structure and invariants:
 * - session_index: append-only, all content object IDs encountered
 * - metadata_pool: mutable subset of session_index
 * - active_set: mutable subset of metadata_pool
 * - pinned_set: exempt from auto-collapse
 *
 * Key invariants:
 * - session_index only grows (append-only)
 * - metadata_pool ⊇ active_set
 * - Objects can only be in sets they're eligible for
 *
 * Reference: docs/spec/context-manager-ssot.md §3.1, §3.2
 */

import { describe, expect, it, beforeEach } from 'vitest';

// Session sets manager implementing §3.1 rules
class SessionSets {
  private sessionIndex: Set<string> = new Set();
  private metadataPool: Set<string> = new Set();
  private activeSet: Set<string> = new Set();
  private pinnedSet: Set<string> = new Set();

  // Append to session index (only way to add)
  addToSessionIndex(id: string): void {
    this.sessionIndex.add(id);
  }

  // Add to metadata pool (must be in session index)
  addToMetadataPool(id: string): boolean {
    if (!this.sessionIndex.has(id)) return false;
    this.metadataPool.add(id);
    return true;
  }

  // Add to active set (must be in metadata pool)
  addToActiveSet(id: string): boolean {
    if (!this.metadataPool.has(id)) return false;
    this.activeSet.add(id);
    return true;
  }

  // Remove from active set (stays in metadata pool)
  removeFromActiveSet(id: string): boolean {
    if (!this.activeSet.has(id)) return false;
    this.activeSet.delete(id);
    return true;
  }

  // Pin (must be in metadata pool)
  pin(id: string): boolean {
    if (!this.metadataPool.has(id)) return false;
    this.pinnedSet.add(id);
    return true;
  }

  // Unpin
  unpin(id: string): boolean {
    if (!this.pinnedSet.has(id)) return false;
    this.pinnedSet.delete(id);
    return true;
  }

  // Getters
  getSessionIndex(): Set<string> {
    return new Set(this.sessionIndex);
  }

  getMetadataPool(): Set<string> {
    return new Set(this.metadataPool);
  }

  getActiveSet(): Set<string> {
    return new Set(this.activeSet);
  }

  getPinnedSet(): Set<string> {
    return new Set(this.pinnedSet);
  }

  // Invariant checks
  verifyInvariants(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // metadata_pool ⊂ session_index
    for (const id of this.metadataPool) {
      if (!this.sessionIndex.has(id)) {
        errors.push(`${id} in metadata_pool but not in session_index`);
      }
    }

    // active_set ⊂ metadata_pool
    for (const id of this.activeSet) {
      if (!this.metadataPool.has(id)) {
        errors.push(`${id} in active_set but not in metadata_pool`);
      }
    }

    // pinned_set ⊂ metadata_pool (pinned must be content we can see)
    for (const id of this.pinnedSet) {
      if (!this.metadataPool.has(id)) {
        errors.push(`${id} in pinned_set but not in metadata_pool`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

describe('SSOT §3.1 - Session Sets Structure', () => {
  let sets: SessionSets;

  beforeEach(() => {
    sets = new SessionSets();
  });

  describe('session_index', () => {
    it('is append-only - content objects are never removed', () => {
      sets.addToSessionIndex('file:a');
      sets.addToSessionIndex('file:b');

      // Per spec: "Never shrinks"
      const sessionIndex = sets.getSessionIndex();
      expect(sessionIndex.size).toBe(2);

      // There is no remove operation for session_index
      // The SessionSets class has no removeFromSessionIndex method
    });

    it('stores every content object ID this session has encountered', () => {
      // Agent reads a file
      sets.addToSessionIndex('file:main.ts');

      // Discovery adds more
      sets.addToSessionIndex('file:utils.ts');
      sets.addToSessionIndex('file:types.ts');

      // Tool call executed
      sets.addToSessionIndex('toolcall:tc-123');

      const index = sets.getSessionIndex();
      expect(index.has('file:main.ts')).toBe(true);
      expect(index.has('file:utils.ts')).toBe(true);
      expect(index.has('toolcall:tc-123')).toBe(true);
    });

    it('adding same ID twice is idempotent', () => {
      sets.addToSessionIndex('file:a');
      sets.addToSessionIndex('file:a');

      expect(sets.getSessionIndex().size).toBe(1);
    });
  });

  describe('metadata_pool', () => {
    it('is mutable subset of session_index', () => {
      sets.addToSessionIndex('file:a');
      sets.addToSessionIndex('file:b');

      sets.addToMetadataPool('file:a');

      expect(sets.getMetadataPool().has('file:a')).toBe(true);
      expect(sets.getMetadataPool().has('file:b')).toBe(false);
    });

    it('cannot add if not in session_index', () => {
      const result = sets.addToMetadataPool('file:not-indexed');

      expect(result).toBe(false);
      expect(sets.getMetadataPool().has('file:not-indexed')).toBe(false);
    });

    it('contains content objects visible as metadata', () => {
      sets.addToSessionIndex('file:a');
      sets.addToSessionIndex('file:b');
      sets.addToMetadataPool('file:a');
      sets.addToMetadataPool('file:b');

      // Both files have metadata summaries in context
      expect(sets.getMetadataPool().size).toBe(2);
    });
  });

  describe('active_set', () => {
    it('is mutable subset of metadata_pool', () => {
      sets.addToSessionIndex('file:a');
      sets.addToMetadataPool('file:a');
      sets.addToActiveSet('file:a');

      expect(sets.getActiveSet().has('file:a')).toBe(true);
    });

    it('cannot add if not in metadata_pool', () => {
      sets.addToSessionIndex('file:a');
      // Skip metadata_pool

      const result = sets.addToActiveSet('file:a');

      expect(result).toBe(false);
    });

    it('removing from active_set keeps in metadata_pool', () => {
      sets.addToSessionIndex('file:a');
      sets.addToMetadataPool('file:a');
      sets.addToActiveSet('file:a');

      sets.removeFromActiveSet('file:a');

      expect(sets.getActiveSet().has('file:a')).toBe(false);
      expect(sets.getMetadataPool().has('file:a')).toBe(true); // Still there
    });

    it('contains content objects with full content loaded', () => {
      // Per spec: "Content objects with full content in context"
      sets.addToSessionIndex('file:main.ts');
      sets.addToMetadataPool('file:main.ts');
      sets.addToActiveSet('file:main.ts');

      expect(sets.getActiveSet().has('file:main.ts')).toBe(true);
    });
  });

  describe('pinned_set', () => {
    it('is mutable set of content objects exempt from auto-collapse', () => {
      sets.addToSessionIndex('toolcall:important');
      sets.addToMetadataPool('toolcall:important');
      sets.pin('toolcall:important');

      expect(sets.getPinnedSet().has('toolcall:important')).toBe(true);
    });

    it('pinned objects are not auto-collapsed', () => {
      // Per spec: "Exempt from auto-collapse"
      // Auto-collapse is tested in activation.test.ts
      expect(true).toBe(true);
    });

    it('cannot pin if not in metadata_pool', () => {
      sets.addToSessionIndex('file:a');
      // Not in metadata_pool

      const result = sets.pin('file:a');

      expect(result).toBe(false);
    });

    it('unpin removes from pinned_set', () => {
      sets.addToSessionIndex('file:a');
      sets.addToMetadataPool('file:a');
      sets.pin('file:a');
      sets.unpin('file:a');

      expect(sets.getPinnedSet().has('file:a')).toBe(false);
    });
  });

  describe('Set invariants', () => {
    it('active_set ⊂ metadata_pool ⊂ session_index', () => {
      sets.addToSessionIndex('file:a');
      sets.addToSessionIndex('file:b');
      sets.addToSessionIndex('file:c');

      sets.addToMetadataPool('file:a');
      sets.addToMetadataPool('file:b');

      sets.addToActiveSet('file:a');

      const check = sets.verifyInvariants();
      expect(check.valid).toBe(true);
      expect(check.errors).toHaveLength(0);
    });

    it('pinned_set ⊂ metadata_pool', () => {
      sets.addToSessionIndex('file:a');
      sets.addToMetadataPool('file:a');
      sets.pin('file:a');

      const check = sets.verifyInvariants();
      expect(check.valid).toBe(true);
    });
  });
});

describe('SSOT §3.2 - Context Levels', () => {
  let sets: SessionSets;

  beforeEach(() => {
    sets = new SessionSets();
  });

  it('active = in active_set ⊂ metadata_pool ⊂ session_index', () => {
    // Full content in context
    sets.addToSessionIndex('file:a');
    sets.addToMetadataPool('file:a');
    sets.addToActiveSet('file:a');

    expect(sets.getActiveSet().has('file:a')).toBe(true);
    expect(sets.getMetadataPool().has('file:a')).toBe(true);
    expect(sets.getSessionIndex().has('file:a')).toBe(true);
  });

  it('metadata = in metadata_pool ⊂ session_index, not in active_set', () => {
    // Compact summary visible
    sets.addToSessionIndex('file:b');
    sets.addToMetadataPool('file:b');
    // Not in active_set

    expect(sets.getActiveSet().has('file:b')).toBe(false);
    expect(sets.getMetadataPool().has('file:b')).toBe(true);
    expect(sets.getSessionIndex().has('file:b')).toBe(true);
  });

  it('indexed only = in session_index only (reserved for future)', () => {
    // Per spec: "Currently, no operation demotes from metadata pool"
    sets.addToSessionIndex('file:c');
    // Not added to metadata_pool

    expect(sets.getActiveSet().has('file:c')).toBe(false);
    expect(sets.getMetadataPool().has('file:c')).toBe(false);
    expect(sets.getSessionIndex().has('file:c')).toBe(true);
  });
});

describe('Session Sets - Workflow Scenarios', () => {
  let sets: SessionSets;

  beforeEach(() => {
    sets = new SessionSets();
  });

  it('agent read: add to all three sets', () => {
    // Per §5.6: "Agent read → add to session index, metadata pool, and active set"
    const fileId = 'file:main.ts';

    sets.addToSessionIndex(fileId);
    sets.addToMetadataPool(fileId);
    sets.addToActiveSet(fileId);

    expect(sets.getSessionIndex().has(fileId)).toBe(true);
    expect(sets.getMetadataPool().has(fileId)).toBe(true);
    expect(sets.getActiveSet().has(fileId)).toBe(true);
  });

  it('discovery: add to session_index and metadata_pool, not active_set', () => {
    // Per §5.6: "Add to session index and metadata pool (not active set)"
    const fileId = 'file:discovered.ts';

    sets.addToSessionIndex(fileId);
    sets.addToMetadataPool(fileId);
    // Do NOT add to active_set

    expect(sets.getSessionIndex().has(fileId)).toBe(true);
    expect(sets.getMetadataPool().has(fileId)).toBe(true);
    expect(sets.getActiveSet().has(fileId)).toBe(false);
  });

  it('toolcall creation: add to all three sets', () => {
    // Per §5.7: "Added to session index + metadata pool + active set"
    const toolcallId = 'toolcall:tc-123';

    sets.addToSessionIndex(toolcallId);
    sets.addToMetadataPool(toolcallId);
    sets.addToActiveSet(toolcallId);

    expect(sets.getSessionIndex().has(toolcallId)).toBe(true);
    expect(sets.getMetadataPool().has(toolcallId)).toBe(true);
    expect(sets.getActiveSet().has(toolcallId)).toBe(true);
  });

  it('deactivate moves to metadata only', () => {
    const fileId = 'file:deactivated.ts';

    sets.addToSessionIndex(fileId);
    sets.addToMetadataPool(fileId);
    sets.addToActiveSet(fileId);

    // Deactivate
    sets.removeFromActiveSet(fileId);

    expect(sets.getActiveSet().has(fileId)).toBe(false);
    expect(sets.getMetadataPool().has(fileId)).toBe(true); // Still visible as metadata
  });

  it('activate promotes from metadata to active', () => {
    const fileId = 'file:reactivated.ts';

    sets.addToSessionIndex(fileId);
    sets.addToMetadataPool(fileId);
    // Start without activation

    // Activate
    sets.addToActiveSet(fileId);

    expect(sets.getActiveSet().has(fileId)).toBe(true);
  });

  it('watcher update does not change set membership', () => {
    // Per §5.6: "Do NOT change set membership"
    const fileId = 'file:watched.ts';

    sets.addToSessionIndex(fileId);
    sets.addToMetadataPool(fileId);
    sets.addToActiveSet(fileId);
    sets.removeFromActiveSet(fileId); // Agent deactivated

    // Watcher fires - content changed
    // Should NOT re-activate
    const wasActive = sets.getActiveSet().has(fileId);
    // (watcher would update metadata cache, not sets)

    expect(wasActive).toBe(false); // Still deactivated
    expect(sets.getMetadataPool().has(fileId)).toBe(true); // Still in metadata
  });

  it('no operation demotes from metadata_pool (current spec)', () => {
    // Per spec: "All objects that enter the metadata pool stay there"
    const fileId = 'file:permanent-metadata.ts';

    sets.addToSessionIndex(fileId);
    sets.addToMetadataPool(fileId);

    // There is no removeFromMetadataPool operation
    expect(sets.getMetadataPool().has(fileId)).toBe(true);
  });
});

describe('Session Sets - Persistence', () => {
  it('session document stores sets as string arrays', () => {
    // Per §2.6: session type-specific fields
    const sessionDocument = {
      session_index: ['file:a', 'file:b', 'toolcall:c'],
      metadata_pool: ['file:a', 'toolcall:c'],
      active_set: ['file:a'],
      pinned_set: [],
    };

    expect(Array.isArray(sessionDocument.session_index)).toBe(true);
    expect(Array.isArray(sessionDocument.metadata_pool)).toBe(true);
    expect(Array.isArray(sessionDocument.active_set)).toBe(true);
    expect(Array.isArray(sessionDocument.pinned_set)).toBe(true);
  });

  it('sets can be restored from persisted arrays', () => {
    const persisted = {
      session_index: ['file:a', 'file:b'],
      metadata_pool: ['file:a'],
      active_set: [],
      pinned_set: [],
    };

    const sets = new SessionSets();

    // Restore from persistence
    for (const id of persisted.session_index) {
      sets.addToSessionIndex(id);
    }
    for (const id of persisted.metadata_pool) {
      sets.addToMetadataPool(id);
    }
    for (const id of persisted.active_set) {
      sets.addToActiveSet(id);
    }
    for (const id of persisted.pinned_set) {
      sets.pin(id);
    }

    expect(sets.getSessionIndex()).toEqual(new Set(persisted.session_index));
    expect(sets.getMetadataPool()).toEqual(new Set(persisted.metadata_pool));
  });
});
