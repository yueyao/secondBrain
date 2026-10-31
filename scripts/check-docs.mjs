#!/usr/bin/env node
/**
 * 文档检查（零依赖）：保证文档不会随代码演进"烂掉"。
 *
 * 规则：
 *   1. docs/ 下每个 .md 都必须登记在 docs/INDEX.md
 *   2. ADR 编号必须从 0001 连续
 *   3. README / AGENTS / INDEX / MAINTENANCE 中引用的 docs/...md 必须存在
 *
 * 用法：pnpm run docs:check（已包含在 pnpm run check 中）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX_FILE = path.join(DOCS, 'INDEX.md');

const violations = [];

function listMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'snapshots') continue; // HTML 快照不参与
      out.push(...listMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

if (!fs.existsSync(INDEX_FILE)) {
  console.error('✗ 缺少 docs/INDEX.md（文档地图）');
  process.exit(1);
}

const indexContent = fs.readFileSync(INDEX_FILE, 'utf8');
const docsFiles = listMarkdown(DOCS).map((file) => path.relative(ROOT, file).split(path.sep).join('/'));

// 1) 所有文档必须在 INDEX 中被提及
for (const file of docsFiles) {
  if (!indexContent.includes(file)) {
    violations.push(`${file} 未登记到 docs/INDEX.md`);
  }
}

// 2) ADR 编号连续
const adrDir = path.join(DOCS, 'adr');
const adrFiles = fs.existsSync(adrDir)
  ? fs.readdirSync(adrDir).filter((name) => name.endsWith('.md')).sort()
  : [];
const adrNumbers = adrFiles.map((name) => Number.parseInt(name.slice(0, 4), 10));
adrNumbers.forEach((number, position) => {
  if (!Number.isInteger(number)) {
    violations.push(`ADR 文件名缺少 4 位编号：${adrFiles[position]}`);
  } else if (number !== position + 1) {
    violations.push(`ADR 编号不连续：期望 ${String(position + 1).padStart(4, '0')}，实际 ${String(number).padStart(4, '0')}`);
  }
});
for (const name of adrFiles) {
  const rel = `docs/adr/${name}`;
  if (!indexContent.includes(rel)) violations.push(`${rel} 未登记到 docs/INDEX.md`);
}

// 3) 关键文档里引用的 docs/*.md 必须存在
const REFERENCING = ['README.md', 'AGENTS.md', 'docs/INDEX.md', 'docs/MAINTENANCE.md'];
const LINK_RE = /docs\/(?:[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\.md/g;
for (const rel of REFERENCING) {
  const absolute = path.join(ROOT, rel);
  if (!fs.existsSync(absolute)) {
    violations.push(`缺少关键文档：${rel}`);
    continue;
  }
  const content = fs.readFileSync(absolute, 'utf8');
  for (const match of content.matchAll(LINK_RE)) {
    const target = match[0];
    if (!fs.existsSync(path.join(ROOT, target))) {
      violations.push(`${rel} 引用了不存在的文档：${target}`);
    }
  }
}

// 4) PROGRESS 必须存在且包含阶段章节
const progress = path.join(DOCS, 'PROGRESS.md');
if (!fs.existsSync(progress)) {
  violations.push('缺少 docs/PROGRESS.md（连续实施日志）');
} else if (!/^## /m.test(fs.readFileSync(progress, 'utf8'))) {
  violations.push('docs/PROGRESS.md 没有章节标题（## ）');
}

if (violations.length > 0) {
  console.error(`✗ 文档检查失败（${violations.length} 项）：`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`✓ 文档检查通过：${docsFiles.length} 份文档，${adrFiles.length} 个 ADR，引用完整、编号连续`);
console.log(`  - docs/INDEX.md 覆盖全部文档`);
console.log(`  - ADR 编号 0001-${String(adrFiles.length).padStart(4, '0')} 连续`);
console.log(`  - README/AGENTS/INDEX/MAINTENANCE 中的 docs 链接均有效`);
