import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ContextManager } from '../src/context-manager.js';
import { ExtensionRuntimeState, toolReferenceText } from '../src/extension-logic.js';
import { XtdbClient } from '../src/xtdb-client.js';
import type { Message } from '../src/message-types.js';

let mock: ChildProcess;

async function startMock(): Promise<void> {
  try {
    await fetch('http://127.0.0.1:3000/_xtdb/status');
    return;
  } catch {
    mock = spawn('node', ['scripts/mock-xtdb-server.mjs'], { cwd: '/workspace/pi-memory', stdio: 'ignore' });
    await sleep(250);
  }
}

beforeAll(async () => {
  await startMock();
});

afterAll(() => {
  mock?.kill('SIGTERM');
});

describe('phase 3 - extension logic', () => {
  it('context assembly handler logic uses context manager output', async () => {
    const cm = new ContextManager(new XtdbClient('http://127.0.0.1:3000'), 'p3-s1');
    const messages: Message[] = [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], api: 'openai-responses', provider: 'openai', model: 'gpt-test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 },
    ];

    await cm.processEvents(messages);
    const assembled = cm.assembleContext('sys prompt');
    expect(assembled.messages.length).toBeGreaterThan(1);
    expect(String((assembled.messages[0] as Message).content)).toContain('metadata_pool');
  });

  it('tool_result interceptor replaces content with metadata reference', async () => {
    const state = new ExtensionRuntimeState();
    await state.ensureXtdb();
    const result = await state.onToolResult({
      toolCallId: 'p3-tool-1',
      toolName: 'bash',
      input: { command: 'ls -la' },
      content: [{ type: 'text', text: 'full output here' }],
      isError: false,
    });

    expect(result?.content[0].text).toBe(toolReferenceText('p3-tool-1', 'bash', false));
  });

  it('file indexing logic stores file objects for read/write/edit outputs', async () => {
    const state = new ExtensionRuntimeState();
    await state.ensureXtdb();
    await state.indexFileArtifacts({
      toolCallId: 'p3-tool-2',
      toolName: 'read',
      input: { path: 'README.md' },
      content: [{ type: 'text', text: 'ignored' }],
      isError: false,
    }, 'README.md');

    const stored = await state.xtdb.get('file:README.md');
    expect(stored).toBeTruthy();
    expect(stored?.type).toBe('file');
  });
});
