# ADR 0004 · 数据库选型：node:sqlite

- 状态：已采纳（P2）
- 日期：2026-10-30

## 背景

P2 需要 StateStore 的持久化实现。候选：

| 方案 | 优点 | 缺点 |
|---|---|---|
| `node:sqlite`（Node 内置） | 零依赖、零原生编译、`DatabaseSync` 同步 API 与单写者模型天然契合 | 实验性 API，未来可能调整 |
| `better-sqlite3` | 成熟、生态好、性能强 | 需要原生编译（node-gyp / 预编译包），升级 Node 时可能踩 ABI |
| `sql.js`（WASM） | 纯 JS | 无文件锁、性能差，不适合常驻服务 |

## 决策

用 **`node:sqlite`**。已在 Node 24.17 实测：

- `new DatabaseSync(':memory:')` / 文件路径均可
- `db.prepare(...).run/get/all` 正常
- `INSERT ... RETURNING *` 正常（领取任务需要）
- `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` 正常

实现封装在 `@sb/adapters-sqlite`，外部只认 `@sb/contracts` 的 `StateStore` 端口。**换库只需换一个包**，应用层与领域层零改动。

## 实现要点

| 需求 | 做法 |
|---|---|
| 事务 | `BEGIN IMMEDIATE`；嵌套调用复用外层事务（depth 计数） |
| 乐观锁 | `UPDATE ... WHERE id = ? AND version = ?`，`changes === 1` 才算成功 |
| 状态存储 | `state` 列存 kind（可索引）+ `state_data` 列存 JSON；读时校验枚举 |
| 事件流 | 与状态同事务插入 `event`；`seq` 自增，`listSince` 增量读 |
| 任务领取 | `UPDATE ... RETURNING *` 原子领取，`fencing_token + 1` |
| 时间 | 由注入的 `Clock` 提供，适配器不直接读系统时钟 |
| 测试 | `:memory:` 库，每个用例独立；迁移可重跑 |

## 后果

- 零原生依赖：`pnpm install` 不需要编译，CI 也不需要 build tools。
- 需要自己维护一份最小 `node:sqlite` 类型声明（`packages/adapters-sqlite/src/node-sqlite.d.ts`），这样根 tsconfig 能保持 `"types": []`，领域层仍拿不到 Node 全局。
- 若 Node 升级导致 API 变更：改动只在适配器包内，`StateStore` 契约不变。
- 若将来需要更强性能：新增 `@sb/adapters-sqlite-better` 包实现同一端口即可，无需改调用方。
