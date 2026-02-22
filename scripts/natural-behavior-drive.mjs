import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PiMemoryPhase3Extension } from '../dist/src/phase3-extension.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const xtdbBaseUrl = process.env.XTDB_URL || 'http://172.17.0.1:3000';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const workspaceRoot = resolve(process.cwd(), `tmp/natural-behavior-drive-${runId}`);
const sessionId = `natural-behavior-${Date.now()}`;
const evidencePath = resolve(process.cwd(), 'docs/rebuild/2026-02-22-natural-behavior-drive-evidence.json');
const reportPath = resolve(process.cwd(), 'docs/rebuild/2026-02-22-natural-behavior-drive-report.md');

const strongSystemPolicy = [
  'You are an autonomous engineering investigator.',
  'Primary optimization target: keep active working memory minimal while staying accurate.',
  'Aggressively activate only what is immediately needed for the current reasoning step.',
  'Aggressively deactivate artifacts once their content is extracted into your notes/answer plan.',
  'Prefer metadata awareness over carrying full content. If needed later, look it up again.',
  'Treat active content as scarce and expensive. Keep it compact and frequently prune.',
  'Use tools extensively to inspect project artifacts and construct evidence-backed conclusions.',
  'Always provide citations as concrete file paths and line snippets from inspected artifacts.',
].join(' ');

const domainTaskPrompt = [
  'Investigate why payment reconciliation failed during yesterday\'s launch window.',
  'Produce a root-cause brief covering: timeline, impact estimate, top 3 contributing factors, conflicting hypotheses, and recovery actions.',
  'You must cite both early design/planning artifacts and late incident/runtime artifacts.',
  'Cross-check contradictions between product notes, SRE logs, analytics exports, and retro notes.',
  'Write final brief to output/final-brief.md and include a section listing unresolved questions.',
].join(' ');

const nowIso = () => new Date().toISOString();

const evidence = {
  startedAt: nowIso(),
  model: MODEL,
  xtdbBaseUrl,
  workspaceRoot,
  sessionId,
  systemPrompt: strongSystemPolicy,
  userPrompt: domainTaskPrompt,
  thresholds: { minToolCalls: 25, minRuntimeMs: 10 * 60 * 1000 },
  trajectory: [],
  toolCalls: [],
  deactivationEvents: [],
  reactivations: [],
  assistantTurns: [],
};

function snapshot(ext, label) {
  const s = ext.getSnapshot();
  const metadata = s.metadataPool;
  return {
    at: nowIso(),
    label,
    activeCount: s.activeSet.size,
    metadataCount: metadata.length,
    activeIds: [...s.activeSet],
    metadataIds: metadata.map((m) => m.id),
  };
}

async function seedDataset(root) {
  const files = {
    'plans/launch-plan.md': `Launch Plan\n- Feature flag staged rollout 10%->50%->100%\n- Payment pipeline v2 enabled at 09:00\n- Backfill job deferred to evening\n`,
    'plans/risk-register.md': `Risk Register\n1) FX rounding drift in partner feed\n2) Queue lag during traffic bursts\n3) Idempotency key collisions if retries exceed 3\n`,
    'notes/product-sync-2026-02-10.md': `Product Sync\n- PM asked to prioritize conversion over reconciliation latency\n- Team accepted temporary alert threshold increase\n`,
    'notes/architecture-review.md': `Architecture Review\n- Reconciliation reads ledger_events and gateway_events\n- join key: external_txn_id\n- known caveat: partner B omits external_txn_id for partial refunds\n`,
    'logs/app-2026-02-21-08.log': `[08:55] startup complete\n[09:03] rollout step 50%\n[09:09] warning reconcile lag=90s\n[09:12] error duplicate key on recon_state\n`,
    'logs/app-2026-02-21-09.log': `[09:15] rollout step 100%\n[09:17] error partner_b payload missing external_txn_id\n[09:19] retry storm detected\n[09:24] reconcile lag=420s\n`,
    'logs/sre-alerts.log': `09:11 alert: reconcile_latency_high\n09:18 alert muted by temporary policy\n09:27 alert: ledger_drift_critical\n`,
    'analytics/conversion.csv': `minute,checkout_success\n09:00,0.81\n09:10,0.84\n09:20,0.85\n09:30,0.80\n`,
    'analytics/reconciliation.csv': `minute,reconciled_ratio\n09:00,0.99\n09:10,0.93\n09:20,0.71\n09:30,0.58\n`,
    'db/query-notes.txt': `Query Notes\n- ledger_events count spiked 3x at 09:18\n- gateway_events steady\n- missing join keys concentrated in partner_b\n`,
    'retro/incident-retro-draft.md': `Retro Draft\n- On-call focused on checkout uptime first\n- Reconciliation drift accepted temporarily\n- Manual replay started 11:40\n`,
    'runbooks/reconciliation-runbook.md': `Runbook\n1) detect drift\n2) pause retries if duplicate keys increase\n3) patch mapper for missing external_txn_id\n4) replay backlog\n`,
    'tickets/TKT-4431.md': `TKT-4431\nTitle: Partner B partial refund mapping\nStatus: Deferred before launch\n`,
    'tickets/TKT-4477.md': `TKT-4477\nTitle: Relax alert threshold during launch\nStatus: Done\n`,
  };

  for (const [p, c] of Object.entries(files)) {
    const abs = resolve(root, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c, 'utf8');
  }

  for (let i = 0; i < 18; i++) {
    const p = `logs/shards/shard-${String(i).padStart(2, '0')}.log`;
    const c = `[09:${String(10 + (i % 40)).padStart(2, '0')}] shard ${i} reconciler heartbeat\n` +
      (i % 4 === 0 ? `[09:${String(12 + (i % 40)).padStart(2, '0')}] duplicate-key anomaly\n` : '');
    const abs = resolve(root, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c, 'utf8');
  }
}

const ext = new PiMemoryPhase3Extension({ sessionId, workspaceRoot, systemPrompt: strongSystemPolicy, xtdbBaseUrl });
await mkdir(workspaceRoot, { recursive: true });
await seedDataset(workspaceRoot);
await ext.load();
evidence.trajectory.push(snapshot(ext, 'after load'));

const toolSchemas = [
  { type: 'function', function: { name: 'ls', description: 'List files recursively under a relative path', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read', description: 'Read UTF-8 text file and activate it in memory', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search literal text in files recursively', parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } }, required: ['path', 'query'] } } },
  { type: 'function', function: { name: 'find', description: 'Find files matching name fragment', parameters: { type: 'object', properties: { path: { type: 'string' }, nameContains: { type: 'string' } }, required: ['path', 'nameContains'] } } },
  { type: 'function', function: { name: 'activate', description: 'Activate known object by id', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'deactivate', description: 'Deactivate object by id', parameters: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'status', description: 'Get memory status snapshot', parameters: { type: 'object', properties: {} } } },
];

const messages = [
  { role: 'system', content: strongSystemPolicy },
  { role: 'user', content: domainTaskPrompt },
];

const priorActive = new Set();
let toolCallCount = 0;
const startMs = Date.now();

async function runTool(name, args, assistantText) {
  if (name === 'ls') {
    const dir = resolve(workspaceRoot, args.path);
    const out = [];
    async function walk(d, base = '') {
      const ents = await readdir(d, { withFileTypes: true });
      for (const e of ents) {
        const rel = `${base}${e.name}`;
        const abs = resolve(d, e.name);
        if (e.isDirectory()) await walk(abs, `${rel}/`);
        else out.push(rel);
      }
    }
    await walk(dir);
    await ext.wrappedLs(out.join('\n'));
    return JSON.stringify({ ok: true, files: out.slice(0, 400), count: out.length });
  }
  if (name === 'read') {
    const res = await ext.read(args.path);
    const abs = resolve(workspaceRoot, args.path);
    const content = await readFile(abs, 'utf8');
    return JSON.stringify({ ...res, path: args.path, content });
  }
  if (name === 'grep') {
    const dir = resolve(workspaceRoot, args.path);
    const hits = [];
    async function walk(d, base = '') {
      const ents = await readdir(d, { withFileTypes: true });
      for (const e of ents) {
        const rel = `${base}${e.name}`;
        const abs = resolve(d, e.name);
        if (e.isDirectory()) await walk(abs, `${rel}/`);
        else {
          const txt = await readFile(abs, 'utf8').catch(() => null);
          if (!txt) continue;
          const lines = txt.split('\n');
          lines.forEach((line, i) => {
            if (line.includes(args.query)) hits.push(`${rel}:${i + 1}:${line}`);
          });
        }
      }
    }
    await walk(dir);
    await ext.wrappedGrep(hits.join('\n'));
    return JSON.stringify({ ok: true, hits: hits.slice(0, 200), count: hits.length });
  }
  if (name === 'find') {
    const dir = resolve(workspaceRoot, args.path);
    const hits = [];
    async function walk(d, base = '') {
      const ents = await readdir(d, { withFileTypes: true });
      for (const e of ents) {
        const rel = `${base}${e.name}`;
        const abs = resolve(d, e.name);
        if (e.isDirectory()) await walk(abs, `${rel}/`);
        else if (e.name.includes(args.nameContains)) hits.push(rel);
      }
    }
    await walk(dir);
    await ext.wrappedFind(hits.join('\n'));
    return JSON.stringify({ ok: true, hits, count: hits.length });
  }
  if (name === 'activate') return JSON.stringify(ext.activate(args.id));
  if (name === 'deactivate') {
    const result = ext.deactivate(args.id);
    evidence.deactivationEvents.push({ at: nowIso(), id: args.id, reason: args.reason || null, assistantContext: assistantText?.slice(0, 400) || null, ok: result.ok });
    return JSON.stringify(result);
  }
  if (name === 'write') {
    await ext.wrappedWrite(args.path, args.content);
    return JSON.stringify({ ok: true });
  }
  if (name === 'status') {
    const s = ext.getSnapshot();
    return JSON.stringify({ activeCount: s.activeSet.size, metadataCount: s.metadataPool.length, activeIds: [...s.activeSet] });
  }
  return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
}

for (let turn = 0; turn < 80; turn++) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages, tools: toolSchemas, tool_choice: 'auto' }),
  });

  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = data.choices[0].message;
  const assistantText = msg.content || '';
  evidence.assistantTurns.push({ at: nowIso(), turn, contentPreview: String(assistantText).slice(0, 500), hasToolCalls: Boolean(msg.tool_calls?.length) });

  if (msg.tool_calls?.length) {
    messages.push({ role: 'assistant', content: assistantText || '', tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      const output = await runTool(tc.function.name, args, assistantText);
      toolCallCount += 1;
      evidence.toolCalls.push({ at: nowIso(), name: tc.function.name, args });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: output });

      const snap = snapshot(ext, `after ${tc.function.name}`);
      evidence.trajectory.push(snap);
      const activeNow = new Set(snap.activeIds);
      for (const id of activeNow) {
        if (!priorActive.has(id) && evidence.deactivationEvents.some((d) => d.id === id)) {
          evidence.reactivations.push({ at: nowIso(), id, triggerTool: tc.function.name });
        }
      }
      priorActive.clear();
      snap.activeIds.forEach((id) => priorActive.add(id));
    }
    continue;
  }

  messages.push({ role: 'assistant', content: assistantText || '' });

  const elapsed = Date.now() - startMs;
  if (toolCallCount >= 25 || elapsed >= 10 * 60 * 1000) break;

  messages.push({
    role: 'user',
    content: 'Continue the investigation: reconcile contradictory evidence between planning docs and latest logs, then strengthen the brief with exact citations before finalizing.',
  });
  await sleep(200);
}

await ext.close();

const trajectory = evidence.trajectory;
const activeSeries = trajectory.map((x) => x.activeCount);
const metadataSeries = trajectory.map((x) => x.metadataCount);

const report = `# Natural Behavior Drive Report (2026-02-22)\n\n## Setup\n- Script: \`scripts/natural-behavior-drive.mjs\`\n- XTDB: \`${xtdbBaseUrl}\` (real)\n- Session: \`${sessionId}\`\n- Model: \`${MODEL}\`\n\n## Caspar Questions\n\n### 1) How did active file/object counts change?\n- Start active count: ${activeSeries[0] ?? 'n/a'}\n- End active count: ${activeSeries[activeSeries.length - 1] ?? 'n/a'}\n- Min/Max active count: ${activeSeries.length ? Math.min(...activeSeries) : 'n/a'} / ${activeSeries.length ? Math.max(...activeSeries) : 'n/a'}\n- Trajectory points: ${activeSeries.join(', ')}\n\n### 2) How did metadata counts change?\n- Start metadata count: ${metadataSeries[0] ?? 'n/a'}\n- End metadata count: ${metadataSeries[metadataSeries.length - 1] ?? 'n/a'}\n- Min/Max metadata count: ${metadataSeries.length ? Math.min(...metadataSeries) : 'n/a'} / ${metadataSeries.length ? Math.max(...metadataSeries) : 'n/a'}\n- Trajectory points: ${metadataSeries.join(', ')}\n\n### 3) Did it activate/deactivate?\n- Activate calls: ${evidence.toolCalls.filter((t) => t.name === 'activate').length}\n- Deactivate calls: ${evidence.toolCalls.filter((t) => t.name === 'deactivate').length}\n- Reactivations of previously deactivated IDs: ${evidence.reactivations.length}\n\n### 4) Why did it deactivate?\nObserved deactivation reasons (from tool args + surrounding assistant context):\n${evidence.deactivationEvents.map((d, i) => `- ${i + 1}. id=${d.id}, reason=${d.reason || 'not explicitly provided'}, ok=${d.ok}`).join('\n') || '- none'}\n\n### 5) When did it choose to deactivate?\nDeactivation timeline:\n${evidence.deactivationEvents.map((d, i) => `- ${i + 1}. ${d.at} id=${d.id}`).join('\n') || '- none'}\n\n## Assessment\nBehavior appears ${evidence.toolCalls.some((t) => t.name === 'deactivate') ? 'natural-ish (domain task drove tool use; deactivation occurred during investigation flow rather than explicit user coaching)' : 'weak (little/no spontaneous deactivation despite policy emphasis)'} based on whether deactivate/activate emerged without explicit user coaching.\n\n## If behavior is still poor: revised system prompt text\n\`\`\`text\nYou are conducting a deep technical investigation with limited working memory. Keep active memory very small: activate an object only when quoting or reasoning from it right now, and deactivate it immediately after extracting needed facts. Rely on metadata/index awareness and re-read later when required. Frequent activate/deactivate is expected whenever your focus changes files or hypotheses. Never keep stale content active across steps unless currently needed for synthesis.\n\`\`\`\n\n## Run Stats\n- Tool calls total: ${toolCallCount}\n- Runtime seconds: ${Math.round((Date.now() - startMs) / 1000)}\n`;

await mkdir(resolve(process.cwd(), 'docs/rebuild'), { recursive: true });
await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
await writeFile(reportPath, report);

console.log(JSON.stringify({ ok: true, toolCallCount, runtimeSec: Math.round((Date.now() - startMs) / 1000), evidencePath, reportPath, sessionId }, null, 2));
