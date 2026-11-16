import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { Store } from "../server/store.ts";
const url = process.env.DATABASE_URL ?? "";
if (!/^\/restorecheck_[0-9a-f]{32}$/.test(new URL(url).pathname))
  throw new Error(
    "Restoration verifier requires a disposable restorecheck database",
  );
let input = "";
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input) as {
  actor: { id: string; token: string };
  document: string;
  checkpoint: string;
  body: string;
  seq: number;
  op: string;
  update: string;
};
const store = new Store(url);
try {
  const actor = await store.byToken(fixture.actor.token);
  assert.equal(actor.id, fixture.actor.id);
  const doc = await store.transaction((db) =>
    store.document(db, actor.tenant, fixture.document),
  );
  assert.equal(doc.content, fixture.body);
  assert.equal(Number(doc.seq), fixture.seq);
  const checkpoint = await store.pool.query(
    "SELECT content FROM checkpoints WHERE id=$1 AND tenant=$2",
    [fixture.checkpoint, actor.tenant],
  );
  assert.equal(checkpoint.rows[0]?.content, "checkpoint baseline");
  const retry = await store.write(
    actor,
    fixture.document,
    fixture.op,
    Buffer.from(fixture.update, "base64"),
  );
  assert.equal(retry.duplicate, true);
  assert.equal(retry.seq, fixture.seq);
  const restored = new Y.Doc();
  try {
    Y.applyUpdate(restored, new Uint8Array(doc.state));
    const before = Y.encodeStateVector(restored);
    const text = restored.getText("body");
    text.insert(text.length, " restored continuation");
    const accepted = await store.write(
      actor,
      fixture.document,
      randomUUID(),
      Y.encodeStateAsUpdate(restored, before),
    );
    assert.equal(accepted.seq, fixture.seq + 1);
    const saved = await store.transaction((db) =>
      store.document(db, actor.tenant, fixture.document),
    );
    assert.equal(saved.content, fixture.body + " restored continuation");
  } finally {
    restored.destroy();
  }
  console.log(
    "PASS: restored credential hash, checkpoint, CRDT state, sequence, duplicate retry, and continued editing",
  );
} finally {
  await store.close();
}
