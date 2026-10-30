#!/usr/bin/env node
/**
 * Monorepo 边界检查（零依赖，`pnpm run boundaries` 执行）。
 *
 * 与 dependency-cruiser 互补：
 *   - depcruise 看"模块图"（方向、环、孤立）
 *   - 本脚本看"源码与包清单"（裸包名、深引、throw、时钟、依赖声明方向）
 *
 * 规则（P1 阶段）：
 *   1. domain / contracts 不得 import node: 内置模块或第三方包
 *   2. 包之间只能用公开面：@sb/domain、@sb/contracts，禁止深引 @sb/domain/src/*
 *   3. domain 不得 import contracts（依赖只能向内）
 *   4. domain / contracts 不得 throw、读时钟、用随机数
 *   5. package.json 的 dependencies 必须与允许的裸导入一致
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

/** 每个包声明：允许的 workspace 裸导入、是否允许 node: 模块、是否纯函数包 */
const PACKAGES = [
  { dir: 'domain', name: '@sb/domain', allowedBare: [], allowNode: false, pure: true },
  { dir: 'contracts', name: '@sb/contracts', allowedBare: ['@sb/domain'], allowNode: false, pure: true },
];

const violations = [];
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collectImports(source) {
  const modules = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) modules.push(match[1]);
  }
  return modules;
}

let scannedFiles = 0;

for (const pkg of PACKAGES) {
  const pkgDir = path.join(PACKAGES_DIR, pkg.dir);
  const srcDir = path.join(pkgDir, 'src');
  const relPkg = path.relative(ROOT, pkgDir);

  if (!fs.existsSync(srcDir)) {
    violations.push(`${relPkg}: 缺少 src/ 目录`);
    continue;
  }

  // 5) package.json 依赖方向
  const manifestPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    violations.push(`${relPkg}: 缺少 package.json`);
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== pkg.name) {
      violations.push(`${relPkg}: package.json name=${manifest.name}，应为 ${pkg.name}`);
    }
    const deps = Object.keys(manifest.dependencies ?? {});
    for (const dep of deps) {
      if (!pkg.allowedBare.includes(dep)) {
        violations.push(`${pkg.name}: 不允许依赖 ${dep}（允许：${pkg.allowedBare.join(', ') || '无'}）`);
      }
    }
    if (pkg.dir === 'domain' && deps.length > 0) {
      violations.push(`${pkg.name}: domain 必须零依赖，实际依赖 ${deps.join(', ')}`);
    }
  }

  for (const file of walk(srcDir)) {
    scannedFiles++;
    const rel = path.relative(ROOT, file);
    const source = fs.readFileSync(file, 'utf8');
    const code = stripComments(source);

    for (const spec of collectImports(source)) {
      if (spec === undefined) continue;

      if (spec.startsWith('node:')) {
        if (!pkg.allowNode) violations.push(`${rel}: 禁止 import node: 模块 (${spec})`);
        continue;
      }

      if (spec.startsWith('@sb/')) {
        if (spec.includes('/src/')) {
          violations.push(`${rel}: 禁止深引包内路径 (${spec})，请从包公开面导入`);
          continue;
        }
        if (!pkg.allowedBare.includes(spec)) {
          violations.push(`${rel}: 不允许依赖包 ${spec}（允许：${pkg.allowedBare.join(', ') || '无'}）`);
        }
        continue;
      }

      if (!spec.startsWith('.')) {
        violations.push(`${rel}: 禁止 import 第三方包 (${spec})`);
        continue;
      }

      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(srcDir + path.sep)) {
        violations.push(`${rel}: 禁止引用 src 之外的路径 (${spec})`);
      }
    }

    if (pkg.pure) {
      if (/\bthrow\b/.test(code)) violations.push(`${rel}: 纯包禁止 throw —— 失败必须通过 Result 返回`);
      if (/\bDate\.now\s*\(/.test(code) || /\bnew\s+Date\s*\(/.test(code)) {
        violations.push(`${rel}: 纯包禁止读时钟 —— 时间由应用层注入`);
      }
      if (/\bMath\.random\s*\(/.test(code)) {
        violations.push(`${rel}: 纯包禁止随机数 —— id 由应用层生成`);
      }
    }
  }
}

// 包目录清单与配置必须一致（防止加了新包却忘了登记边界规则）
const onDisk = fs
  .readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const configured = PACKAGES.map((pkg) => pkg.dir).sort();
const unregistered = onDisk.filter((dir) => !configured.includes(dir));
if (unregistered.length > 0) {
  violations.push(`packages/ 下存在未登记边界规则的包：${unregistered.join(', ')} —— 请在 PACKAGES 中登记`);
}

if (violations.length > 0) {
  console.error(`✗ 边界检查失败（扫描 ${scannedFiles} 个文件）：`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`✓ 边界检查通过：${PACKAGES.length} 个包 / ${scannedFiles} 个文件，0 违规`);
for (const pkg of PACKAGES) {
  console.log(`  - ${pkg.name}: 允许依赖 [${pkg.allowedBare.join(', ') || '无'}]，纯函数包=${pkg.pure}`);
}
console.log('  - 无 node: 模块、无第三方包、无深引、无 domain→contracts 反向依赖');
console.log('  - 无 throw / Date.now / new Date / Math.random');
