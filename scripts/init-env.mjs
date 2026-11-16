import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
writeFileSync(
  ".env",
  "ADMIN_KEY=" + randomBytes(40).toString("base64url") + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Created fresh local development credentials in .env; existing files are never overwritten.",
);
