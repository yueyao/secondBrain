/** 模型配置自检：解析配置并打印每个任务的 profile 链（不调用模型、不花钱）。 */
import fs from 'node:fs';
import path from 'node:path';
import { parseModelPolicy, routeProfiles, type AgentTask } from '@sb/agent-runtime';

const file = process.argv[2] ?? 'config/model-profiles.deepseek.example.json';
const absolute = path.resolve(process.cwd(), file);
if (!fs.existsSync(absolute)) {
  console.error(`配置不存在：${absolute}`);
  process.exit(1);
}

const parsed = parseModelPolicy(JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown);
if (!parsed.ok) {
  console.error('✗ 配置不合法：');
  for (const error of parsed.errors) console.error(`  - ${error}`);
  process.exit(1);
}

const { profiles, policies, budget } = parsed.value;
console.log(`✓ 配置合法：${absolute}`);
console.log(`  profiles: ${profiles.map((profile) => profile.id).join(', ')}`);
console.log(`  budget: ${JSON.stringify(budget)}`);

for (const task of ['triage', 'digest', 'review-rewrite', 'decide'] as readonly AgentTask[]) {
  for (const sensitivity of ['public', 'restricted'] as const) {
    const routing = routeProfiles(task, sensitivity, profiles, policies);
    console.log(
      `  ${task.padEnd(14)} ${sensitivity.padEnd(10)} → ${routing.chain.map((profile) => profile.id).join(' → ') || '(无)'}`,
    );
    for (const rejected of routing.rejected) console.log(`     跳过 ${rejected.id}：${rejected.reason}`);
  }
}
