/** 哈希能力由组合根注入：应用层保持不读 Node 全局。 */
export interface HashPort {
  sha256(text: string): string;
}
