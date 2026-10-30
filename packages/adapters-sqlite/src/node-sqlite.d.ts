/**
 * 最小 node:sqlite 类型声明。
 * 不引入 @types/node：只声明本适配器实际用到的那部分 API，
 * 这样根 tsconfig 可以保持 "types": []，领域层不会意外拿到 Node 全局。
 */
declare module 'node:sqlite' {
  export interface RunResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    run(...params: readonly unknown[]): RunResult;
    get(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
