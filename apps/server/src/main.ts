/** 启动入口：node src/main.ts（默认 http://127.0.0.1:8787） */
import path from 'node:path';
import { createRuntime } from './runtime';
import { createServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), '.sb-demo');

const runtime = await createRuntime({ dataDir });
const server = createServer(runtime);

server.listen(port, host, () => {
  console.log(`secondBrain 审核台 → http://${host}:${port}`);
  console.log(`数据目录: ${dataDir}`);
});

const shutdown = async (): Promise<void> => {
  server.close();
  await runtime.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
