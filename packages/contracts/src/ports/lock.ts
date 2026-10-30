/** 单写者锁：同一时刻只允许一个进程写 vault（设计文档 §8）。 */
export type Release = () => Promise<void>;

export interface LockPort {
  /** 拿不到锁必须失败，不得静默继续；失败语义由实现决定。 */
  acquire(key: string): Promise<Release>;
}
