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
