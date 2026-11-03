/**
 * 模型策略配置解析（P4.2）：JSON → profiles / policies / budget。
 * 纯函数，不读文件与环境变量（由组合根负责）。
 */
import type { Sensitivity } from '@sb/contracts';
import type { BudgetLimits } from './budget';
import type { AgentTask, ModelProfile, TaskPolicy } from './route';

export interface ModelPolicyConfig {
  readonly profiles: readonly ModelProfile[];
  readonly policies: Readonly<Record<AgentTask, TaskPolicy>>;
  readonly budget: BudgetLimits;
}

export type ParseModelPolicyResult =
  | { readonly ok: true; readonly value: ModelPolicyConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

const TASKS: readonly AgentTask[] = ['triage', 'digest', 'review-rewrite', 'decide', 'compose'];
const SENSITIVITIES: readonly Sensitivity[] = ['public', 'restricted'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProfile(raw: unknown, index: number, errors: string[]): ModelProfile | null {
  const start = errors.length;
  const path = `profiles[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${path} 不是对象`);
    return null;
  }

  const id = raw.id;
  const provider = raw.provider;
  const model = raw.model;
  if (typeof id !== 'string' || id === '') errors.push(`${path}.id 必须是非空字符串`);
  if (typeof provider !== 'string' || provider === '') errors.push(`${path}.provider 必须是非空字符串`);
  if (typeof model !== 'string' || model === '') errors.push(`${path}.model 必须是非空字符串`);

  const caps = raw.capabilities;
  if (!isRecord(caps)) {
    errors.push(`${path}.capabilities 必须是对象`);
  } else {
    if (typeof caps.contextTokens !== 'number' || caps.contextTokens <= 0) errors.push(`${path}.capabilities.contextTokens 必须是正数`);
    if (typeof caps.structuredOutput !== 'boolean') errors.push(`${path}.capabilities.structuredOutput 必须是布尔值`);
    if (typeof caps.toolCalls !== 'boolean') errors.push(`${path}.capabilities.toolCalls 必须是布尔值`);
    const sensitivity = caps.sensitivity;
    if (!Array.isArray(sensitivity) || sensitivity.length === 0) {
      errors.push(`${path}.capabilities.sensitivity 必须是非空数组`);
    } else if (sensitivity.some((entry) => typeof entry !== 'string' || !SENSITIVITIES.includes(entry as Sensitivity))) {
      errors.push(`${path}.capabilities.sensitivity 含非法值`);
    }
  }

  const pricing = raw.pricing;
  if (!isRecord(pricing)) {
    errors.push(`${path}.pricing 必须是对象`);
  } else {
    if (typeof pricing.inPerMTokens !== 'number' || pricing.inPerMTokens < 0) errors.push(`${path}.pricing.inPerMTokens 必须是非负数`);
    if (typeof pricing.outPerMTokens !== 'number' || pricing.outPerMTokens < 0) errors.push(`${path}.pricing.outPerMTokens 必须是非负数`);
  }

  const limits = raw.limits;
  if (!isRecord(limits)) {
    errors.push(`${path}.limits 必须是对象`);
  } else {
    if (typeof limits.maxConcurrency !== 'number' || limits.maxConcurrency <= 0) errors.push(`${path}.limits.maxConcurrency 必须是正数`);
    if (typeof limits.requestsPerMinute !== 'number' || limits.requestsPerMinute <= 0) errors.push(`${path}.limits.requestsPerMinute 必须是正数`);
  }

  const providerOptions = raw.providerOptions;
  if (providerOptions !== undefined && !isRecord(providerOptions)) {
    errors.push(`${path}.providerOptions 必须是对象`);
  }

  const health = raw.health;
  if (!isRecord(health)) {
    errors.push(`${path}.health 必须是对象`);
  } else {
    if (typeof health.enabled !== 'boolean') errors.push(`${path}.health.enabled 必须是布尔值`);
    if (!Array.isArray(health.fallbackTo)) errors.push(`${path}.health.fallbackTo 必须是数组`);
  }

  if (errors.length > start) return null;
  const capabilities = caps as Record<string, unknown>;
  const pricingSafe = pricing as Record<string, number>;
  const limitsSafe = limits as Record<string, number>;
  const healthSafe = health as { enabled: boolean; fallbackTo: string[] };
  return {
    id: id as string,
    provider: provider as string,
    model: model as string,
    capabilities: {
      contextTokens: capabilities.contextTokens as number,
      structuredOutput: capabilities.structuredOutput as boolean,
      toolCalls: capabilities.toolCalls as boolean,
      languages: Array.isArray(capabilities.languages) ? (capabilities.languages as string[]) : [],
      sensitivity: capabilities.sensitivity as Sensitivity[],
    },
    pricing: { inPerMTokens: pricingSafe.inPerMTokens ?? 0, outPerMTokens: pricingSafe.outPerMTokens ?? 0 },
    limits: {
      maxConcurrency: limitsSafe.maxConcurrency ?? 1,
      requestsPerMinute: limitsSafe.requestsPerMinute ?? 60,
    },
    health: { enabled: healthSafe.enabled, fallbackTo: healthSafe.fallbackTo },
    ...(providerOptions !== undefined && isRecord(providerOptions) ? { providerOptions } : {}),
  };
}

function parsePolicy(raw: unknown, task: AgentTask, errors: string[]): TaskPolicy | null {
  const start = errors.length;
  const path = `policies.${task}`;
  if (!isRecord(raw)) {
    errors.push(`${path} 必须是对象`);
    return null;
  }
  const requires = raw.requires;
  if (!isRecord(requires)) {
    errors.push(`${path}.requires 必须是对象`);
  } else {
    if (typeof requires.contextTokens !== 'number' || requires.contextTokens <= 0) errors.push(`${path}.requires.contextTokens 必须是正数`);
    if (typeof requires.structuredOutput !== 'boolean') errors.push(`${path}.requires.structuredOutput 必须是布尔值`);
    if (typeof requires.toolCalls !== 'boolean') errors.push(`${path}.requires.toolCalls 必须是布尔值`);
  }
  if (!Array.isArray(raw.profileOrder) || raw.profileOrder.length === 0) errors.push(`${path}.profileOrder 必须是非空数组`);
  for (const key of ['maxInputTokens', 'maxOutputTokens', 'expectedClaims'] as const) {
    if (typeof raw[key] !== 'number' || raw[key] <= 0) errors.push(`${path}.${key} 必须是正数`);
  }
  if (errors.length > start) return null;

  const requiresSafe = requires as Record<string, unknown>;
  return {
    task,
    requires: {
      contextTokens: requiresSafe.contextTokens as number,
      structuredOutput: requiresSafe.structuredOutput as boolean,
      toolCalls: requiresSafe.toolCalls as boolean,
    },
    profileOrder: raw.profileOrder as string[],
    maxInputTokens: raw.maxInputTokens as number,
    maxOutputTokens: raw.maxOutputTokens as number,
    expectedClaims: raw.expectedClaims as number,
  };
}

export function parseModelPolicy(raw: unknown): ParseModelPolicyResult {
  if (!isRecord(raw)) return { ok: false, errors: ['根节点必须是对象'] };
  const errors: string[] = [];

  const profilesRaw = raw.profiles;
  if (!Array.isArray(profilesRaw) || profilesRaw.length === 0) {
    return { ok: false, errors: ['profiles 必须是非空数组'] };
  }
  const profiles = profilesRaw
    .map((entry, index) => parseProfile(entry, index, errors))
    .filter((entry): entry is ModelProfile => entry !== null);

  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) errors.push(`profile id 重复：${profile.id}`);
    ids.add(profile.id);
  }
  for (const profile of profiles) {
    for (const fallback of profile.health.fallbackTo) {
      if (!ids.has(fallback)) errors.push(`profile ${profile.id} 的 fallbackTo 指向不存在的 profile：${fallback}`);
    }
  }

  const policiesRaw = raw.policies;
  if (!isRecord(policiesRaw)) {
    errors.push('policies 必须是对象');
  }

  const policies: Partial<Record<AgentTask, TaskPolicy>> = {};
  const digestPolicy = isRecord(policiesRaw) ? parsePolicy(policiesRaw.digest, 'digest', errors) : null;
  if (digestPolicy) policies.digest = digestPolicy;

  for (const task of TASKS) {
    if (task === 'digest') continue;
    if (isRecord(policiesRaw) && policiesRaw[task] !== undefined) {
      const parsed = parsePolicy(policiesRaw[task], task, errors);
      if (parsed) policies[task] = parsed;
    } else if (digestPolicy) {
      policies[task] = { ...digestPolicy, task };
    }
  }

  if (!policies.digest) errors.push('缺少 digest 策略');
  for (const policy of Object.values(policies)) {
    if (!policy) continue;
    for (const id of policy.profileOrder) {
      if (!ids.has(id)) errors.push(`策略 ${policy.task} 引用了不存在的 profile：${id}`);
    }
  }

  if (errors.length > 0 || !policies.digest) return { ok: false, errors };

  const budgetRaw = raw.budget;
  const budget: { taskCostLimit?: number; dailyCostLimit?: number } = {};
  if (isRecord(budgetRaw)) {
    if (typeof budgetRaw.taskCostLimit === 'number' && budgetRaw.taskCostLimit > 0) budget.taskCostLimit = budgetRaw.taskCostLimit;
    if (typeof budgetRaw.dailyCostLimit === 'number' && budgetRaw.dailyCostLimit > 0) budget.dailyCostLimit = budgetRaw.dailyCostLimit;
  }

  return {
    ok: true,
    value: { profiles, policies: policies as Record<AgentTask, TaskPolicy>, budget },
  };
}
