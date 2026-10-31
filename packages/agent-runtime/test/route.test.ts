import { describe, expect, it } from 'vitest';
import { routeProfiles } from '../src/route';
import { cheap, disabled, policies, profiles } from './fixtures';

describe('能力路由', () => {
  it('digest 需要工具调用：cheap 因上下文不足被排除，strong 的 fallback（mid）进入链尾', () => {
    const { chain, rejected } = routeProfiles('digest', 'public', profiles, policies);
    expect(chain.map((profile) => profile.id)).toEqual(['strong', 'mid']);
    expect(rejected).toContainEqual({ id: 'cheap', reason: 'context_too_small' });
  });

  it('fallbackTo 会追加到链尾并去重', () => {
    const { chain } = routeProfiles('triage', 'public', profiles, policies);
    expect(chain.map((profile) => profile.id)).toEqual(['strong', 'mid']);
  });

  it('敏感度分流：restricted 只能走声明了 restricted 的 profile', () => {
    const { chain, rejected } = routeProfiles('digest', 'restricted', profiles, policies);
    expect(chain.map((profile) => profile.id)).toEqual(['strong']);
    expect(rejected).toContainEqual({ id: 'mid', reason: 'sensitivity_restricted_denied' });
  });

  it('禁用的 profile 被跳过并记录原因', () => {
    const { chain, rejected } = routeProfiles('digest', 'public', profiles, policies);
    expect(chain.map((profile) => profile.id)).not.toContain(disabled.id);
    expect(rejected).toContainEqual({ id: disabled.id, reason: 'disabled' });
  });

  it('没有可用 profile 时返回空链（runner 会抛 NO_PROFILE）', () => {
    const { chain } = routeProfiles('digest', 'restricted', [cheap], policies);
    expect(chain).toEqual([]);
  });
});
