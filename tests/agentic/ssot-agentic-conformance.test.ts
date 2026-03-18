import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelfContextManager } from '../../src/index.js';
import {
  baseWrite,
  cleanupStorageHarness,
  createStorageHarness,
  type StorageHarness,
} from '../storage/test-helpers.js';

describe('Agentic SSOT conformance (intent + implementation-agentic)', () => {
  let harness: StorageHarness;
  let workspaceRoot: string;
  let manager: SelfContextManager;
  let sessionId: string;

  beforeEach(async () => {
    harness = await createStorageHarness();
    workspaceRoot = await mkdtemp(join(tmpdir(), 'scm-agentic-'));
    sessionId = `agentic-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    manager = new SelfContextManager({
      sessionId,
      workspaceRoot,
      systemPrompt: 'SYS',
      storage: harness.storage,
    });

    await manager.load();
  });

  afterEach(async () => {
    await manager.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await cleanupStorageHarness(harness);
  });

  it('uses StoragePort boundary only in runtime loader (no direct sqlite usage in SelfContextManager)', async () => {
    const source = await readFile(new URL('../../src/phase3-extension.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("from 'node:sqlite'");
    expect(source).not.toContain('DatabaseSync');
  });

  it('assembles deterministic block order and honors dynamic-vs-pinned divergence', async () => {
    await manager.wrappedWrite('zeta.txt', 'zeta-v1');
    const zetaRead = await manager.read('zeta.txt');

    await manager.wrappedWrite('alpha.txt', 'alpha-v1');
    const alphaRead = await manager.read('alpha.txt');

    expect(manager.pin(alphaRead.id!).ok).toBe(true);
    await manager.transformContext([]);

    await manager.wrappedWrite('alpha.txt', 'alpha-v2');

    const assembled = await manager.transformContext([]);
    const assembledAgain = await manager.transformContext([]);

    expect(assembledAgain).toEqual(assembled);

    expect(assembled[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(assembled[1]).toMatchObject({ role: 'user' });
    expect((assembled[1] as { content: string }).content.startsWith('METADATA_POOL')).toBe(true);

    const activeBlocks = assembled
      .filter((message) => message.role === 'user' && (message as { content: string }).content.startsWith('ACTIVE_CONTENT id='))
      .map((message) => (message as { content: string }).content);

    const alphaActive = activeBlocks.find((line) => line.includes(`id=${alphaRead.id}`) && line.includes('source=active_set'));
    const alphaPinned = activeBlocks.find((line) => line.includes(`id=${alphaRead.id}`) && line.includes('source=pinned_set'));
    const zetaActive = activeBlocks.find((line) => line.includes(`id=${zetaRead.id}`) && line.includes('source=active_set'));

    expect(alphaActive).toContain('alpha-v2');
    expect(alphaPinned).toContain('alpha-v1');
    expect(zetaActive).toContain('zeta-v1');

    const firstActiveIndex = assembled.findIndex(
      (message) => message.role === 'user' && (message as { content: string }).content.startsWith('ACTIVE_CONTENT id='),
    );
    expect(firstActiveIndex).toBeGreaterThan(1);

    const alphaActiveIndex = activeBlocks.findIndex((line) => line.includes(`id=${alphaRead.id}`) && line.includes('source=active_set'));
    const zetaActiveIndex = activeBlocks.findIndex((line) => line.includes(`id=${zetaRead.id}`) && line.includes('source=active_set'));
    const alphaPinnedIndex = activeBlocks.findIndex((line) => line.includes(`id=${alphaRead.id}`) && line.includes('source=pinned_set'));

    expect(alphaActiveIndex).toBeGreaterThanOrEqual(0);
    expect(zetaActiveIndex).toBeGreaterThan(alphaActiveIndex);
    expect(alphaPinnedIndex).toBeGreaterThan(zetaActiveIndex);
  });

  it('resolves from latest session HEAD refs and keeps inactive/unresolved refs visible in metadata', async () => {
    await manager.wrappedWrite('manual-active.md', 'manual-active-content');
    await manager.wrappedWrite('inactive.md', 'inactive-content');

    const manualActiveId = `file:${join(workspaceRoot, 'manual-active.md')}`;
    const inactiveId = `file:${join(workspaceRoot, 'inactive.md')}`;

    await manager.transformContext([]);

    const latestSession = await harness.storage.getLatest(manager.sessionObjectId);
    expect(latestSession).not.toBeNull();
    if (!latestSession) return;

    const manualHead = await harness.storage.putVersion(
      baseWrite({
        requestId: `manual-head-${Date.now()}`,
        objectId: manager.sessionObjectId,
        objectType: 'session',
        expectedCurrentVersionId: latestSession.versionId,
        sessionId,
        writerId: 'manual-tester',
        writerKind: 'client',
        writeReason: 'manual',
        contentStruct: {
          chat_ref: { target_object_id: manager.chatObjectId, mode: 'dynamic', ref_kind: 'chat' },
          system_prompt_ref: {
            target_object_id: manager.systemPromptObjectId,
            mode: 'dynamic',
            ref_kind: 'system',
          },
          active_set: [
            { target_object_id: manualActiveId, mode: 'dynamic', ref_kind: 'manual-active' },
            { target_object_id: 'file:missing-agentic', mode: 'dynamic', ref_kind: 'manual-missing' },
          ],
          inactive_set: [{ target_object_id: inactiveId, mode: 'dynamic', ref_kind: 'manual-inactive' }],
          pinned_set: [],
        },
        metadata: JSON.parse(latestSession.metadataJson) as Record<string, unknown>,
      }),
    );

    expect(manualHead.ok).toBe(true);

    const assembled = await manager.transformContext([]);
    const metadataBlock = assembled[1] as { role: 'user'; content: string };

    expect(metadataBlock.role).toBe('user');
    expect(metadataBlock.content).toContain(`inactive_ref id=${inactiveId}`);
    expect(metadataBlock.content).toContain('unresolved_ref scope=active_set id=file:missing-agentic');

    const manualActiveBlock = assembled.find(
      (message) =>
        message.role === 'user' &&
        (message as { content: string }).content.startsWith(`ACTIVE_CONTENT id=${manualActiveId}`),
    ) as { content: string } | undefined;

    expect(manualActiveBlock?.content).toContain('manual-active-content');

    const inactiveExpanded = assembled.find(
      (message) =>
        message.role === 'user' &&
        (message as { content: string }).content.startsWith(`ACTIVE_CONTENT id=${inactiveId}`),
    );

    expect(inactiveExpanded).toBeUndefined();
  });

  it('surfaces version_conflict instead of silently clobbering externally advanced session HEAD', async () => {
    await manager.wrappedWrite('external.txt', 'v1');
    await manager.transformContext([]);

    const objectId = `file:${join(workspaceRoot, 'external.txt')}`;
    const objectV1 = await harness.storage.getLatest(objectId);
    expect(objectV1).not.toBeNull();
    if (!objectV1) return;

    const baseSession = await harness.storage.getLatest(manager.sessionObjectId);
    expect(baseSession).not.toBeNull();
    if (!baseSession) return;

    const externalHead = await harness.storage.putVersion(
      baseWrite({
        requestId: `external-session-${Date.now()}`,
        objectId: manager.sessionObjectId,
        objectType: 'session',
        expectedCurrentVersionId: baseSession.versionId,
        sessionId,
        writerId: 'external-writer',
        writerKind: 'client',
        writeReason: 'manual',
        contentStruct: {
          chat_ref: { target_object_id: manager.chatObjectId, mode: 'dynamic', ref_kind: 'chat' },
          system_prompt_ref: { target_object_id: manager.systemPromptObjectId, mode: 'dynamic', ref_kind: 'system' },
          active_set: [],
          inactive_set: [],
          pinned_set: [
            {
              target_object_id: objectId,
              mode: 'pinned',
              target_object_hash: objectV1.objectHash,
              ref_kind: 'external-pin',
            },
          ],
        },
        metadata: JSON.parse(baseSession.metadataJson) as Record<string, unknown>,
      }),
    );

    expect(externalHead.ok).toBe(true);

    await manager.wrappedWrite('external.txt', 'v2');

    await expect(manager.transformContext([])).rejects.toThrow('storage_conflict:version_conflict:session:');

    const latestSession = await harness.storage.getLatest(manager.sessionObjectId);
    expect(latestSession?.versionId).toBe(externalHead.ok ? externalHead.record.versionId : null);

    const latestContent = JSON.parse(latestSession!.contentStructJson) as { pinned_set?: Array<unknown> };
    expect(Array.isArray(latestContent.pinned_set) ? latestContent.pinned_set.length : 0).toBe(1);
  });
});
