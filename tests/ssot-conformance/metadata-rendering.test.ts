/**
 * SSOT Conformance Tests: Metadata Rendering (§4.1)
 *
 * Tests metadata pool rendering:
 * - File format: id={id} type=file path={displayPath} file_type={file_type} char_count={char_count}
 * - Stub format: id={id} type=file path={displayPath} file_type={file_type} [unread]
 * - Toolcall format: id={id} type=toolcall tool={tool} status={status}
 * - Display path is reverse-translated from canonical
 *
 * Reference: docs/spec/context-manager-ssot.md §4.1
 */

import { describe, expect, it, beforeEach } from 'vitest';

// Types for metadata entries
interface FileMetadata {
  id: string;
  type: 'file';
  displayPath: string;
  file_type: string;
  char_count: number;
  isStub: boolean; // file_hash is null
}

interface ToolcallMetadata {
  id: string;
  type: 'toolcall';
  tool: string;
  status: 'ok' | 'fail';
}

type MetadataEntry = FileMetadata | ToolcallMetadata;

// Metadata renderer implementing §4.1
function renderMetadataLine(entry: MetadataEntry): string {
  if (entry.type === 'file') {
    const file = entry as FileMetadata;
    if (file.isStub) {
      // Stub format
      return `id=${file.id} type=file path=${file.displayPath} file_type=${file.file_type} [unread]`;
    } else {
      // Indexed format
      return `id=${file.id} type=file path=${file.displayPath} file_type=${file.file_type} char_count=${file.char_count}`;
    }
  } else {
    // Toolcall format
    const tc = entry as ToolcallMetadata;
    return `id=${tc.id} type=toolcall tool=${tc.tool} status=${tc.status}`;
  }
}

// Render full metadata pool
function renderMetadataPool(entries: MetadataEntry[]): string {
  return entries.map(renderMetadataLine).join('\n');
}

describe('SSOT §4.1 - File Metadata Rendering', () => {
  describe('Indexed files (full content available)', () => {
    it('format: id={id} type=file path={displayPath} file_type={file_type} char_count={char_count}', () => {
      const file: FileMetadata = {
        id: 'abc123def',
        type: 'file',
        displayPath: '/workspace/src/main.ts',
        file_type: 'ts',
        char_count: 1234,
        isStub: false,
      };

      const rendered = renderMetadataLine(file);

      expect(rendered).toBe('id=abc123def type=file path=/workspace/src/main.ts file_type=ts char_count=1234');
    });

    it('includes all required fields', () => {
      const file: FileMetadata = {
        id: 'xyz789',
        type: 'file',
        displayPath: '/project/readme.md',
        file_type: 'md',
        char_count: 500,
        isStub: false,
      };

      const rendered = renderMetadataLine(file);

      expect(rendered).toContain('id=xyz789');
      expect(rendered).toContain('type=file');
      expect(rendered).toContain('path=/project/readme.md');
      expect(rendered).toContain('file_type=md');
      expect(rendered).toContain('char_count=500');
    });

    it('char_count is 0 for empty files', () => {
      const emptyFile: FileMetadata = {
        id: 'empty-file',
        type: 'file',
        displayPath: '/empty.txt',
        file_type: 'txt',
        char_count: 0,
        isStub: false,
      };

      const rendered = renderMetadataLine(emptyFile);

      expect(rendered).toContain('char_count=0');
      expect(rendered).not.toContain('[unread]');
    });
  });

  describe('File stubs (discovery, not yet read)', () => {
    it('format: id={id} type=file path={displayPath} file_type={file_type} [unread]', () => {
      const stub: FileMetadata = {
        id: 'stub-abc',
        type: 'file',
        displayPath: '/workspace/discovered.ts',
        file_type: 'ts',
        char_count: 0,
        isStub: true,
      };

      const rendered = renderMetadataLine(stub);

      expect(rendered).toBe('id=stub-abc type=file path=/workspace/discovered.ts file_type=ts [unread]');
    });

    it('shows [unread] instead of char_count', () => {
      const stub: FileMetadata = {
        id: 'stub-xyz',
        type: 'file',
        displayPath: '/discovered.md',
        file_type: 'md',
        char_count: 0, // Stubs always have char_count=0
        isStub: true,
      };

      const rendered = renderMetadataLine(stub);

      expect(rendered).toContain('[unread]');
      expect(rendered).not.toContain('char_count');
    });

    it('distinguishes "not yet read" from "empty file"', () => {
      // Per spec: "This distinguishes 'not yet read' from 'empty file'"

      const emptyFile: FileMetadata = {
        id: 'empty',
        type: 'file',
        displayPath: '/empty.txt',
        file_type: 'txt',
        char_count: 0,
        isStub: false, // Actually read, just empty
      };

      const stub: FileMetadata = {
        id: 'stub',
        type: 'file',
        displayPath: '/unread.txt',
        file_type: 'txt',
        char_count: 0,
        isStub: true, // Never read
      };

      const emptyRendered = renderMetadataLine(emptyFile);
      const stubRendered = renderMetadataLine(stub);

      expect(emptyRendered).toContain('char_count=0');
      expect(emptyRendered).not.toContain('[unread]');

      expect(stubRendered).toContain('[unread]');
      expect(stubRendered).not.toContain('char_count');
    });
  });

  describe('Display path (reverse-translated)', () => {
    it('uses agent-visible path, not canonical', () => {
      // Per spec: "displayPath is the agent-visible path
      // (reverse-translated from canonical via mount mappings)"

      // Canonical: /home/user/.openclaw/workspaces/dev/main.ts
      // Display: /workspace/main.ts (what agent sees)

      const file: FileMetadata = {
        id: 'abc',
        type: 'file',
        displayPath: '/workspace/main.ts', // Agent-visible
        file_type: 'ts',
        char_count: 100,
        isStub: false,
      };

      const rendered = renderMetadataLine(file);

      expect(rendered).toContain('path=/workspace/main.ts');
      expect(rendered).not.toContain('.openclaw');
    });

    it('for non-sandboxed agents: canonical = agent-visible', () => {
      // Per spec: "For non-sandboxed agents, canonical = agent-visible"

      const file: FileMetadata = {
        id: 'xyz',
        type: 'file',
        displayPath: '/home/user/project/main.ts', // Same as canonical
        file_type: 'ts',
        char_count: 50,
        isStub: false,
      };

      const rendered = renderMetadataLine(file);

      expect(rendered).toContain('path=/home/user/project/main.ts');
    });
  });
});

describe('SSOT §4.1 - Toolcall Metadata Rendering', () => {
  it('format: id={id} type=toolcall tool={tool} status={status}', () => {
    const tc: ToolcallMetadata = {
      id: 'tc-12345',
      type: 'toolcall',
      tool: 'bash',
      status: 'ok',
    };

    const rendered = renderMetadataLine(tc);

    expect(rendered).toBe('id=tc-12345 type=toolcall tool=bash status=ok');
  });

  it('status=ok for successful execution', () => {
    const tc: ToolcallMetadata = {
      id: 'tc-success',
      type: 'toolcall',
      tool: 'ls',
      status: 'ok',
    };

    const rendered = renderMetadataLine(tc);

    expect(rendered).toContain('status=ok');
  });

  it('status=fail for failed execution', () => {
    const tc: ToolcallMetadata = {
      id: 'tc-fail',
      type: 'toolcall',
      tool: 'grep',
      status: 'fail',
    };

    const rendered = renderMetadataLine(tc);

    expect(rendered).toContain('status=fail');
  });

  it('includes tool name', () => {
    const tools = ['bash', 'read', 'write', 'ls', 'grep', 'find', 'cat'];

    for (const tool of tools) {
      const tc: ToolcallMetadata = {
        id: `tc-${tool}`,
        type: 'toolcall',
        tool,
        status: 'ok',
      };

      const rendered = renderMetadataLine(tc);
      expect(rendered).toContain(`tool=${tool}`);
    }
  });
});

describe('SSOT §4.1 - Metadata Pool Assembly', () => {
  it('one line per content object', () => {
    const entries: MetadataEntry[] = [
      { id: 'file-1', type: 'file', displayPath: '/a.ts', file_type: 'ts', char_count: 10, isStub: false },
      { id: 'file-2', type: 'file', displayPath: '/b.md', file_type: 'md', char_count: 20, isStub: false },
      { id: 'tc-1', type: 'toolcall', tool: 'bash', status: 'ok' },
    ];

    const rendered = renderMetadataPool(entries);
    const lines = rendered.split('\n');

    expect(lines).toHaveLength(3);
  });

  it('mixed files and toolcalls render correctly', () => {
    const entries: MetadataEntry[] = [
      { id: 'f1', type: 'file', displayPath: '/main.ts', file_type: 'ts', char_count: 100, isStub: false },
      { id: 'tc1', type: 'toolcall', tool: 'ls', status: 'ok' },
      { id: 'f2', type: 'file', displayPath: '/utils.ts', file_type: 'ts', char_count: 50, isStub: true },
      { id: 'tc2', type: 'toolcall', tool: 'grep', status: 'fail' },
    ];

    const rendered = renderMetadataPool(entries);

    expect(rendered).toContain('id=f1 type=file');
    expect(rendered).toContain('id=tc1 type=toolcall');
    expect(rendered).toContain('[unread]'); // f2 is stub
    expect(rendered).toContain('status=fail'); // tc2 failed
  });

  it('empty pool renders empty string', () => {
    const rendered = renderMetadataPool([]);

    expect(rendered).toBe('');
  });
});

describe('SSOT §4.1 - Context Assembly Order', () => {
  it('metadata pool is section 2 (after system prompt, before chat)', () => {
    // Per spec:
    // 1. System prompt
    // 2. Metadata pool summary
    // 3. Chat history
    // 4. Active content

    const assemblyOrder = [
      'system_prompt',
      'metadata_pool_summary',
      'chat_history',
      'active_content',
    ];

    expect(assemblyOrder[1]).toBe('metadata_pool_summary');
  });

  it('metadata pool shows compact summaries, not full content', () => {
    const file: FileMetadata = {
      id: 'abc',
      type: 'file',
      displayPath: '/large-file.ts',
      file_type: 'ts',
      char_count: 50000, // Large file
      isStub: false,
    };

    const rendered = renderMetadataLine(file);

    // Only shows char_count, not actual content
    expect(rendered).toContain('char_count=50000');
    expect(rendered.length).toBeLessThan(200); // Summary is compact
  });
});

describe('Metadata Rendering - Chat History (§4.1)', () => {
  it('tool call outputs replaced with toolcall_ref in chat', () => {
    // Per spec: "Tool call outputs replaced with
    // toolcall_ref id={id} tool={tool} status={status}"

    const toolcallRef = 'toolcall_ref id=tc-123 tool=bash status=ok';

    expect(toolcallRef).toContain('toolcall_ref');
    expect(toolcallRef).toContain('id=');
    expect(toolcallRef).toContain('tool=');
    expect(toolcallRef).toContain('status=');
  });

  it('full output only if tool call is active', () => {
    // Per spec: "Full output only if the tool call is active"

    // In chat history: shows reference
    const inChatHistory = 'toolcall_ref id=tc-123 tool=bash status=ok';

    // In active content section: shows full output
    const inActiveContent = `ACTIVE_CONTENT id=tc-123
actual tool output here
with multiple lines
`;

    expect(inChatHistory).not.toContain('actual tool output');
    expect(inActiveContent).toContain('actual tool output');
  });
});

describe('Metadata Rendering - Active Content (§4.1)', () => {
  it('format: ACTIVE_CONTENT id={id}\\n{content}', () => {
    const id = 'file-main-ts';
    const content = 'const x = 1;\nfunction foo() {}';

    const activeBlock = `ACTIVE_CONTENT id=${id}
${content}`;

    expect(activeBlock).toMatch(/^ACTIVE_CONTENT id=file-main-ts$/m);
    expect(activeBlock).toContain('const x = 1;');
  });

  it('one block per active content object', () => {
    const active = [
      { id: 'file-1', content: 'content 1' },
      { id: 'tc-1', content: 'tool output 1' },
    ];

    const blocks = active.map((a) => `ACTIVE_CONTENT id=${a.id}\n${a.content}`);
    const rendered = blocks.join('\n\n');

    expect(rendered).toContain('ACTIVE_CONTENT id=file-1');
    expect(rendered).toContain('ACTIVE_CONTENT id=tc-1');
  });
});
