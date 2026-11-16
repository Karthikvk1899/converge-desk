import { writeFile } from "node:fs/promises";
import { build } from "../server/app.ts";
import { config } from "../server/config.ts";
process.env.ADMIN_KEY = "documentation-only-not-a-real-secret";
const { app } = await build(config(), false);
await app.ready();
await writeFile(
  "docs/openapi.json",
  JSON.stringify(app.swagger(), null, 2) + "\n",
);
await app.close();
