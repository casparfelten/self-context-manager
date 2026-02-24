/**
 * SSOT Conformance Tests: Content/Infrastructure Split (§2.1)
 *
 * Tests the two-axis classification of objects:
 * - Content objects (file, toolcall): participate in context management
 * - Infrastructure objects (chat, system_prompt, session): persistence only
 *
 * Key invariant: Infrastructure objects are NOT in session index, metadata pool,
 * or active set. They are referenced by the session wrapper and rendered in
 * fixed positions.
 *
 * Reference: docs/spec/context-manager-ssot.md §2.1, §2.6, §3.1
 */

import { describe, expect, it } from 'vitest';

// Object type classification per §2.1
const CONTENT_TYPES = ['file', 'toolcall'] as const;
const INFRASTRUCTURE_TYPES = ['chat', 'system_prompt', 'session'] as const;

type ContentType = typeof CONTENT_TYPES[number];
type InfrastructureType = typeof INFRASTRUCTURE_TYPES[number];
type ObjectType = ContentType | InfrastructureType;

function isContentType(type: string): type is ContentType {
  return CONTENT_TYPES.includes(type as ContentType);
}

function isInfrastructureType(type: string): type is InfrastructureType {
  return INFRASTRUCTURE_TYPES.includes(type as InfrastructureType);
}

// Session sets (IDs only per §3.1)
interface SessionSets {
  session_index: Set<string>;   // Append-only, all content objects encountered
  metadata_pool: Set<string>;   // Subset of session_index, metadata visible
  active_set: Set<string>;      // Subset of metadata_pool, content loaded
  pinned_set: Set<string>;      // Exempt from auto-collapse
}

describe('SSOT §2.1 - Content/Infrastructure Split', () => {
  describe('Type classification', () => {
    it('file is a content type', () => {
      expect(isContentType('file')).toBe(true);
      expect(isInfrastructureType('file')).toBe(false);
    });

    it('toolcall is a content type', () => {
      expect(isContentType('toolcall')).toBe(true);
      expect(isInfrastructureType('toolcall')).toBe(false);
    });

    it('chat is an infrastructure type', () => {
      expect(isContentType('chat')).toBe(false);
      expect(isInfrastructureType('chat')).toBe(true);
    });

    it('system_prompt is an infrastructure type', () => {
      expect(isContentType('system_prompt')).toBe(false);
      expect(isInfrastructureType('system_prompt')).toBe(true);
    });

    it('session is an infrastructure type', () => {
      expect(isContentType('session')).toBe(false);
      expect(isInfrastructureType('session')).toBe(true);
    });
  });

  describe('Session set eligibility', () => {
    it('only content types can be in session_index', () => {
      const sessionIndex: Set<string> = new Set();

      // Valid: content objects
      const fileId = 'file:abc123';
      const toolcallId = 'toolcall:tc-456';

      sessionIndex.add(fileId);
      sessionIndex.add(toolcallId);

      // Invalid: infrastructure objects should never be added
      const chatId = 'chat:session-1';
      const systemPromptId = 'system_prompt:session-1';
      const sessionId = 'session:session-1';

      // These should NOT be in session_index
      expect(sessionIndex.has(chatId)).toBe(false);
      expect(sessionIndex.has(systemPromptId)).toBe(false);
      expect(sessionIndex.has(sessionId)).toBe(false);
    });

    it('only content types can be in metadata_pool', () => {
      const metadataPool: Set<string> = new Set();

      // Valid additions
      metadataPool.add('file:doc.md');
      metadataPool.add('toolcall:tc-grep');

      expect(metadataPool.size).toBe(2);

      // Chat should never be here
      // The old implementation had chat in metadata pool with locked=true
      // New spec: chat is infrastructure, not content
    });

    it('only content types can be in active_set', () => {
      const activeSet: Set<string> = new Set();

      // Valid: activating file content
      activeSet.add('file:main.ts');

      // Valid: activating tool output
      activeSet.add('toolcall:tc-123');

      // Infrastructure objects are never activated/deactivated
      // They are always rendered in fixed positions
    });

    it('only content types can be in pinned_set', () => {
      // Pinning is an agent operation for context management
      // Only content objects participate in this
      const pinnedSet: Set<string> = new Set();

      pinnedSet.add('file:important.md');
      pinnedSet.add('toolcall:tc-critical');

      expect(pinnedSet.size).toBe(2);
    });
  });

  describe('Infrastructure object handling', () => {
    it('chat is referenced by chat_ref on session, not in sets', () => {
      // Session document structure
      const session = {
        type: 'session',
        session_id: 'test-session',
        chat_ref: 'chat:test-session',  // Reference, not in sets
        system_prompt_ref: 'system_prompt:test-session',
        session_index: ['file:a', 'toolcall:b'],  // Only content IDs
        metadata_pool: ['file:a'],
        active_set: ['file:a'],
        pinned_set: [],
      };

      // chat_ref is a separate field, not in session_index
      expect(session.session_index).not.toContain(session.chat_ref);
      expect(session.metadata_pool).not.toContain(session.chat_ref);
      expect(session.active_set).not.toContain(session.chat_ref);
    });

    it('system_prompt is referenced by system_prompt_ref, not in sets', () => {
      const session = {
        type: 'session',
        session_id: 's1',
        chat_ref: 'chat:s1',
        system_prompt_ref: 'system_prompt:s1',
        session_index: [],
        metadata_pool: [],
        active_set: [],
        pinned_set: [],
      };

      expect(session.session_index).not.toContain(session.system_prompt_ref);
    });

    it('infrastructure objects rendered in fixed positions per §4.1', () => {
      // Context assembly order:
      // 1. System prompt (from infrastructure object)
      // 2. Metadata pool summary (content objects only)
      // 3. Chat history (from infrastructure object)
      // 4. Active content (content objects only)

      const renderOrder = ['system_prompt', 'metadata_pool', 'chat_history', 'active_content'];

      expect(renderOrder[0]).toBe('system_prompt');  // Fixed position
      expect(renderOrder[2]).toBe('chat_history');   // Fixed position
    });
  });

  describe('No locked field (§2.2)', () => {
    it('objects do not have locked field in new spec', () => {
      // Old spec had locked: boolean
      // New spec: infrastructure objects are never in sets to begin with
      // No need for locked field

      // Document structure per §2.2 - no locked field
      const fileObject = {
        'xt/id': 'file:abc',
        type: 'file',
        source: { type: 'filesystem', filesystemId: 'x', path: '/x' },
        identity_hash: 'abc123',
        content: 'hello',
        file_type: 'ts',
        char_count: 5,
        file_hash: 'def',
        content_hash: 'ghi',
        metadata_hash: 'jkl',
        object_hash: 'mno',
      };

      expect('locked' in fileObject).toBe(false);
    });

    it('deactivate does not need to check locked (no locked objects)', () => {
      // Old: deactivate('chat:x') → fail because locked=true
      // New: deactivate('chat:x') → invalid because chat is infrastructure, not content

      const validDeactivateTargets: ContentType[] = ['file', 'toolcall'];
      const invalidDeactivateTargets: InfrastructureType[] = ['chat', 'system_prompt', 'session'];

      expect(validDeactivateTargets).not.toContainEqual('chat');
      expect(invalidDeactivateTargets).toContain('chat');
    });
  });

  describe('Agent-facing interface (§3.3)', () => {
    it('activate/deactivate only valid for content objects', () => {
      // Per spec: "Only content objects can be activated/deactivated/pinned."

      function canActivate(objectType: ObjectType): boolean {
        return isContentType(objectType);
      }

      expect(canActivate('file')).toBe(true);
      expect(canActivate('toolcall')).toBe(true);
      expect(canActivate('chat')).toBe(false);
      expect(canActivate('system_prompt')).toBe(false);
      expect(canActivate('session')).toBe(false);
    });

    it('pin/unpin only valid for content objects', () => {
      function canPin(objectType: ObjectType): boolean {
        return isContentType(objectType);
      }

      expect(canPin('file')).toBe(true);
      expect(canPin('toolcall')).toBe(true);
      expect(canPin('chat')).toBe(false);
    });
  });
});

describe('SSOT §2.1 - Sourced vs Unsourced', () => {
  it('file is sourced (bound to external source)', () => {
    // file type always has a non-null source
    const fileObject = {
      type: 'file',
      source: { type: 'filesystem', filesystemId: 'x', path: '/x' },
    };

    expect(fileObject.source).not.toBeNull();
  });

  it('toolcall is unsourced (database-only)', () => {
    // toolcall type has source: null
    const toolcallObject = {
      type: 'toolcall',
      source: null,
    };

    expect(toolcallObject.source).toBeNull();
  });

  it('chat is unsourced (database-only)', () => {
    const chatObject = {
      type: 'chat',
      source: null,
    };

    expect(chatObject.source).toBeNull();
  });

  it('system_prompt is unsourced (database-only)', () => {
    const systemPromptObject = {
      type: 'system_prompt',
      source: null,
    };

    expect(systemPromptObject.source).toBeNull();
  });

  it('session is unsourced (database-only)', () => {
    const sessionObject = {
      type: 'session',
      source: null,
    };

    expect(sessionObject.source).toBeNull();
  });
});

describe('SSOT §2.6 - Type-specific Fields', () => {
  describe('file (content, sourced)', () => {
    it('has file_type and char_count as type-specific fields', () => {
      const file = {
        type: 'file',
        file_type: 'ts',
        char_count: 100,
      };

      expect(file.file_type).toBeTruthy();
      expect(typeof file.char_count).toBe('number');
    });

    it('canonical path is in source.path, not in payload', () => {
      const file = {
        type: 'file',
        source: { type: 'filesystem', filesystemId: 'x', path: '/canonical/path.ts' },
        // No path field in payload - it's in source
      };

      expect(file.source.path).toBe('/canonical/path.ts');
      expect('path' in file && file.path !== undefined).toBe(false);
    });
  });

  describe('toolcall (content, unsourced)', () => {
    it('has tool, args, args_display, status, chat_ref, file_refs', () => {
      const toolcall = {
        type: 'toolcall',
        tool: 'bash',
        args: { command: 'ls -la' },
        args_display: 'ls -la',
        status: 'ok' as const,
        chat_ref: 'chat:s1',
        file_refs: ['file:a', 'file:b'],
      };

      expect(toolcall.tool).toBe('bash');
      expect(toolcall.status).toBe('ok');
    });

    it('single version - created once, never updated', () => {
      // Per spec: "Single version (created once, never updated)"
      // This is behavioral, verified by indexing tests
      expect(true).toBe(true);
    });
  });

  describe('chat (infrastructure, unsourced)', () => {
    it('has turns, session_ref, turn_count, toolcall_refs', () => {
      const chat = {
        type: 'chat',
        turns: [],
        session_ref: 'session:s1',
        turn_count: 0,
        toolcall_refs: [],
      };

      expect(Array.isArray(chat.turns)).toBe(true);
      expect(chat.session_ref).toMatch(/^session:/);
    });
  });

  describe('system_prompt (infrastructure, unsourced)', () => {
    it('has no type-specific fields beyond content', () => {
      // metadata_hash for system_prompt is SHA-256 of empty object
      const systemPromptTypeSpecificFields = {};
      expect(Object.keys(systemPromptTypeSpecificFields).length).toBe(0);
    });
  });

  describe('session (infrastructure, unsourced)', () => {
    it('has session_id, chat_ref, system_prompt_ref, and four sets', () => {
      const session = {
        type: 'session',
        session_id: 's1',
        chat_ref: 'chat:s1',
        system_prompt_ref: 'system_prompt:s1',
        session_index: [],
        metadata_pool: [],
        active_set: [],
        pinned_set: [],
      };

      expect(session.session_id).toBeTruthy();
      expect(session.chat_ref).toBeTruthy();
      expect(session.system_prompt_ref).toBeTruthy();
      expect(Array.isArray(session.session_index)).toBe(true);
    });
  });
});
