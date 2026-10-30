import { makeFinding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';

export const eventAlreadyDigestedRule: Rule<RuleInput> = {
  id: 'r-event-already-digested',
  defaultSeverity: 'block',
  description: '同一事件（event_id）已有另一来源入库时，第二份必须是 canonical 的补证或被驳回',
  evaluate(input) {
    if (!input.eventId) return null;
    const canonical = input.items.find(
      (item) =>
        item.eventId === input.eventId &&
        item.rawPath !== input.rawPath &&
        item.stateKind === 'committed',
    );
    if (!canonical) return null;
    return makeFinding(
      'r-event-already-digested',
      'block',
      'EVENT_ALREADY_DIGESTED',
      `同一事件已由另一来源入库：${canonical.rawPath}`,
      { eventId: input.eventId, canonicalRawPath: canonical.rawPath },
    );
  },
};
