import { makeFinding, type Rule } from '../model/finding';
import type { ItemRef, RuleInput } from '../model/rule-input';
import type { RawStateKind } from '../model/raw-state';

const IN_FLIGHT: readonly RawStateKind[] = ['queued', 'drafting', 'draft_ready', 'in_review', 'changes_requested'];

export const eventInQueueRule: Rule<RuleInput> = {
  id: 'r-event-in-queue',
  defaultSeverity: 'warn',
  description: '队列中已存在同一事件的其他来源时提醒：先处理信息量大的那份',
  evaluate(input) {
    if (!input.eventId) return null;
    const siblings = input.items.filter(
      (item: ItemRef) =>
        item.eventId === input.eventId &&
        item.rawPath !== input.rawPath &&
        IN_FLIGHT.includes(item.stateKind),
    );
    if (siblings.length === 0) return null;
    return makeFinding(
      'r-event-in-queue',
      'warn',
      'EVENT_IN_QUEUE',
      `队列中存在同一事件的其他来源：${siblings.map((item) => item.rawPath).join('、')}`,
      { eventId: input.eventId, siblings: siblings.map((item) => item.rawPath) },
    );
  },
};
