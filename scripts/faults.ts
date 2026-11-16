import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  principal,
  create,
  Peer,
  request,
  until,
  API_A,
  API_B,
} from "../tests/client.ts";
const a = await principal("fault-" + randomUUID().slice(0, 8), "Fault tester");
const d = await create(a.token);
const left = await Peer.connect(a.token, d.id, API_A),
  right = await Peer.connect(a.token, d.id, API_B);
const compose = (action: string, service: string) =>
  execFileSync("docker", ["compose", action, service], { stdio: "pipe" });
async function ready(base: string) {
  for (let i = 0; i < 30; i++) {
    try {
      if (
        (
          await fetch(base + "/health/ready", {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("readiness timeout");
}
try {
  compose("stop", "redis");
  const first = left.edit("redis-outage ");
  const op = left.send(first);
  await left.ack(op);
  await until(() => right.text().includes("redis-outage"));
  assert.equal(
    (await request(`/api/documents/${d.id}/tickets`, a.token, "POST")).status,
    503,
  );
  console.log(
    "PASS: existing sessions commit and converge during Redis outage; new tickets fail closed",
  );
  compose("start", "redis");
  await ready(API_A);
  compose("stop", "api1");
  await until(() => left.closed);
  const replacement = await Peer.connect(a.token, d.id, API_B);
  replacement.send(first, op);
  assert.equal((await replacement.ack(op)).duplicate, true);
  replacement.close();
  console.log(
    "PASS: acknowledged state survives replica restart and retry is deduplicated",
  );
  compose("start", "api1");
  await ready(API_A);
  compose("stop", "db");
  const pending = right.edit("db-recovery");
  const pendingId = right.send(pending);
  await until(() =>
    right.events.find(
      (e) => e.type === "error" && e.op_id === pendingId && e.retryable,
    ),
  );
  assert(!right.events.some((e) => e.type === "ack" && e.op_id === pendingId));
  compose("start", "db");
  await ready(API_B);
  right.send(pending, pendingId);
  await right.ack(pendingId);
  const saved = await (
    await request("/api/documents/" + d.id, a.token, "GET", undefined, API_B)
  ).json();
  assert(saved.body.includes("db-recovery"));
  console.log(
    "PASS: no acknowledgment during database outage; identical retry commits after recovery",
  );
} finally {
  left.close();
  right.close();
  for (const service of ["db", "redis", "api1"]) compose("start", service);
}
