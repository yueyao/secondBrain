/**
 * 云端模式端到端：本地假 OpenAI 服务 + 真实 runtime + 真实 git/SQLite。
 * 不访问外网、不花钱，但走的是与生产完全相同的代码路径。
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideReview, draftDigest, ingestAndTriage, usageSummary } from '@sb/app';
import { parseRawPath, type RawPath } from '@sb/domain';
import { createRuntime, type Runtime } from '../src/runtime';

const RAW = 'raw/knowledge/notions/mock-2026-10-02 幂律分布.md';

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const proposal = {
  tier: 'standard',
  rationale: '云端模式测试',
  claims: [{ text: '这是一条来自假模型的、足够长的判断。', inference: false, source: RAW }],
  nodes: [{ name: '幂律分布', nodeType: 'concept', action: 'new', definition: '测试定义' }],
};

let runtime: Runtime;
let dataDir: string;
let fakeServer: http.Server;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  fakeServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1234, completion_tokens: 234 },
      }));
    });
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  const { port } = fakeServer.address() as AddressInfo;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cloud-'));
  const configPath = path.join(dataDir, 'profiles.json');
  fs.writeFileSync(configPath, JSON.stringify({
    profiles: [{
      id: 'fake-flash',
      provider: 'fake',
      model: 'fake-model-2026-01',
      capabilities: { contextTokens: 1_000_000, structuredOutput: true, toolCalls: true, languages: ['zh'], sensitivity: ['public', 'restricted'] },
      pricing: { inPerMTokens: 1, outPerMTokens: 2 },
      limits: { maxConcurrency: 1, requestsPerMinute: 60 },
      health: { enabled: true, fallbackTo: [] },
    }],
    policies: {
      digest: {
        requires: { contextTokens: 60_000, structuredOutput: true, toolCalls: true },
        profileOrder: ['fake-flash'],
        maxInputTokens: 60_000,
        maxOutputTokens: 4_000,
        expectedClaims: 8,
      },
    },
    budget: {},
  }));

  savedEnv = {
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    MODEL_CONFIG: process.env.MODEL_CONFIG,
  };
  process.env.MODEL_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.MODEL_API_KEY = 'test-key';
  process.env.MODEL_CONFIG = configPath;

  runtime = await createRuntime({ dataDir, seedDemo: true });
});

afterAll(async () => {
  await runtime.close();
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('云端模式（假 OpenAI 服务）', () => {
  it('runtime 识别为 cloud 模式', () => {
    expect(runtime.mode).toBe('cloud');
  });

  it('ingest → digest → accept：产出写入 wiki，usage 记录真实 tokens 与成本', async () => {
    await ingestAndTriage(runtime.ctx);

    const rawPath: RawPath = must(parseRawPath(RAW));
    const draft = await draftDigest(runtime.ctx, rawPath);
    expect(draft.proposal.tier).toBe('standard');

    const result = await decideReview(runtime.ctx, draft.draftId, 'accept', { actor: 'owner' });
    expect(result.commit).toBeTruthy();

    const content = await runtime.vault.readNode('wiki/concepts/幂律分布.md');
    expect(content).toContain('这是一条来自假模型的');

    const usage = await usageSummary(runtime.ctx);
    expect(usage.totals.calls).toBe(1);
    expect(usage.totals.inputTokens).toBe(1234);
    expect(usage.totals.outputTokens).toBe(234);
    // 1234/1e6*1 + 234/1e6*2 = 0.001702
    expect(usage.totals.estimatedCost).toBeCloseTo(0.001702, 6);
    expect(usage.byProfile[0]?.profileId).toBe('fake-flash');
  });
});
