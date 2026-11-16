import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { principal, create, Peer, request } from "../tests/client.ts";
// This rehearsal creates and removes only a uniquely named disposable database.
const database = "restorecheck_" + randomUUID().replaceAll("-", "");
const actor = await principal(
  "restore-" + randomUUID().slice(0, 8),
  "Restore tester",
);
const document = await create(
  actor.token,
  "Restore rehearsal",
  "checkpoint baseline",
);
const checkpointResponse = await request(
  `/api/documents/${document.id}/checkpoints`,
  actor.token,
  "POST",
  { label: "before edit", expected_seq: 0 },
);
assert.equal(checkpointResponse.status, 201);
const checkpoint = await checkpointResponse.json();
const peer = await Peer.connect(actor.token, document.id);
let payload: Uint8Array;
let op: string;
try {
  payload = peer.edit(" acknowledged update");
  op = peer.send(payload);
  await peer.ack(op);
} finally {
  peer.close();
}
const original = await (
  await request(`/api/documents/${document.id}`, actor.token)
).json();
const command = (args: string[], input?: Uint8Array) =>
  execFileSync("docker", ["compose", "exec", "-T", "db", ...args], {
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60000,
  });
let created = false;
try {
  const dump = command([
    "pg_dump",
    "-U",
    "desk",
    "-d",
    "desk",
    "--format=custom",
    "--no-owner",
    "--no-acl",
  ]);
  command(["createdb", "-U", "desk", database]);
  created = true;
  command(
    [
      "pg_restore",
      "-U",
      "desk",
      "-d",
      database,
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
    ],
    dump,
  );
  const fixture = {
    actor,
    document: document.id,
    checkpoint: checkpoint.id,
    body: original.body,
    seq: original.seq,
    op,
    update: Buffer.from(payload).toString("base64"),
  };
  const result = execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "-e",
      `DATABASE_URL=postgresql://desk:local-dev-only@db:5432/${database}`,
      "api1",
      "node",
      "scripts/verify-restore.ts",
    ],
    { input: JSON.stringify(fixture), timeout: 30000, encoding: "utf8" },
  );
  process.stdout.write(result);
  const unchanged = await (
    await request(`/api/documents/${document.id}`, actor.token)
  ).json();
  assert.equal(unchanged.body, original.body);
  assert.equal(unchanged.seq, original.seq);
  console.log(
    "PASS: logical dump restored into an isolated database; source document remains unchanged",
  );
} finally {
  if (created) command(["dropdb", "-U", "desk", database]);
}
