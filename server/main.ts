import { build } from "./app.ts";
import { config } from "./config.ts";
const cfg = config();
const { app } = await build(cfg);
await app.listen({ host: "0.0.0.0", port: cfg.port });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
