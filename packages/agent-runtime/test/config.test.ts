import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseModelPolicy } from '../src/config';

const base = {
  profiles: [
    {
      id: 'strong',
      provider: 'openai-compatible',
      model: 'large-2026-01',
      capabilities: { contextTokens: 128000, structuredOutput: true, toolCalls: true, languages: ['zh'], sensitivity: ['public', 'restricted'] },
      pricing: { inPerMTokens: 10, outPerMTokens: 30 },
      limits: { maxConcurrency: 4, requestsPerMinute: 60 },
      health: { enabled: true, fallbackTo: ['mid'] },
    },
    {
      id: 'mid',
      provider: 'openai-compatible',
      model: 'mid-2026-01',
      capabilities: { contextTokens: 128000, structuredOutput: true, toolCalls: true, languages: ['zh'], sensitivity: ['public', 'restricted'] },
      pricing: { inPerMTokens: 4, outPerMTokens: 8 },
      limits: { maxConcurrency: 6, requestsPerMinute: 90 },
      health: { enabled: true, fallbackTo: [] },
    },
  ],
  policies: {
    digest: {
      requires: { contextTokens: 60000, structuredOutput: true, toolCalls: true },
      profileOrder: ['strong', 'mid'],
      maxInputTokens: 60000,
      maxOutputTokens: 4000,
      expectedClaims: 8,
    },
  },
  budget: { dailyCostLimit: 5 },
};

const clone = () => JSON.parse(JSON.stringify(base)) as typeof base;

describe('模型策略配置解析', () => {
  it('合法配置通过，未显式配置的任务复用 digest 策略', () => {
    const result = parseModelPolicy(clone());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profiles).toHaveLength(2);
    expect(result.value.policies.digest.profileOrder).toEqual(['strong', 'mid']);
    expect(result.value.policies.triage.profileOrder).toEqual(['strong', 'mid']);
    expect(result.value.budget).toEqual({ dailyCostLimit: 5 });
  });

  it('缺少 digest 策略时报错', () => {
    const raw = clone();
    raw.policies = {} as typeof raw.policies;
    const result = parseModelPolicy(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(';')).toContain('digest');
  });

  it('重复 profile id 报错', () => {
    const raw = clone();
    raw.profiles.push({ ...raw.profiles[0]! });
    const result = parseModelPolicy(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(';')).toContain('重复');
  });

  it('fallbackTo 指向不存在的 profile 报错', () => {
    const raw = clone();
    raw.profiles[0]!.health.fallbackTo = ['ghost'];
    const result = parseModelPolicy(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(';')).toContain('ghost');
  });

  it('非法敏感度值报错', () => {
    const raw = clone();
    raw.profiles[0]!.capabilities.sensitivity = ['secret' as never];
    const result = parseModelPolicy(raw);
    expect(result.ok).toBe(false);
  });

  it('策略引用不存在的 profile 报错', () => {
    const raw = clone();
    raw.policies.digest.profileOrder = ['ghost'];
    const result = parseModelPolicy(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(';')).toContain('ghost');
  });
});


describe('DeepSeek 示例配置', () => {
  it('可直接解析，且 providerOptions 被保留', () => {
    const file = path.resolve(import.meta.dirname, '../../../config/model-profiles.deepseek.example.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const result = parseModelPolicy(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profiles.map((profile) => profile.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(result.value.profiles[0]?.providerOptions).toMatchObject({ thinking: { type: 'disabled' } });
    expect(result.value.policies.digest.profileOrder).toEqual(['deepseek-flash']);
    expect(result.value.policies.triage.profileOrder).toEqual(['deepseek-flash']);
  });
});

describe('compose 策略（主编台 C2）', () => {
  it('未显式配置 compose 时复用 digest 策略', () => {
    const result = parseModelPolicy(clone());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policies.compose.task).toBe('compose');
    expect(result.value.policies.compose.profileOrder).toEqual(['strong', 'mid']);
    expect(result.value.policies.compose.expectedClaims).toBe(8);
  });

  /** 断言某个模型配置文件里 compose 策略的硬指标（缺文件时跳过，本地配置不入库）。 */
  function expectComposePolicy(file: string): void {
    const absolute = path.resolve(import.meta.dirname, '../../../', file);
    if (!fs.existsSync(absolute)) return;
    const raw = JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown;
    const result = parseModelPolicy(raw);
    expect(result.ok, file).toBe(true);
    if (!result.ok) return;
    expect(result.value.policies.compose, file).toMatchObject({
      requires: { structuredOutput: false, toolCalls: false },
      maxOutputTokens: 8000,
      expectedClaims: 12,
    });
    expect(result.value.policies.compose.profileOrder.length, file).toBeGreaterThan(0);
  }

  it('仓库内模型示例配置都带 compose 策略（纯文本输出、8000 输出 token、12 条预期 claims）', () => {
    expectComposePolicy('config/model-profiles.example.json');
    expectComposePolicy('config/model-profiles.deepseek.example.json');
  });

  it('本地 model-profiles.json（gitignore）存在时也带 compose 策略', () => {
    expectComposePolicy('config/model-profiles.json');
  });
});
