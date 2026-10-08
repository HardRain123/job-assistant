import { resolve } from "node:path";
import { Store } from "../../../packages/storage/src/index.ts";
import { createApp } from "./app.ts";
import { secret } from "./security.ts";
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const store = new Store(resolve(dataDir, "jobs.sqlite"));
const app = await createApp({
  store,
  password: secret("APP_PASSWORD"),
  key: secret("APP_KEY"),
  internalToken: secret("INTERNAL_TOKEN"),
  dataDir,
  attachmentsDir: resolve(process.env.ATTACHMENTS_DIR ?? "data/attachments"),
  workerUrl: process.env.WORKER_URL,
  bridgeUrl: process.env.BRIDGE_URL,
});
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
});
console.log(
  "Job Assistant ready at http://localhost:" + String(process.env.PORT ?? 3000),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
