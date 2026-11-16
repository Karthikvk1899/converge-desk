import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import * as Y from "yjs";
import { LocalCache } from "../web/cache.ts";
it("atomically retains local state and pending operation across reopen, then removes only acknowledged ID", async () => {
  const name = "test-" + crypto.randomUUID();
  let cache = new LocalCache(name);
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "offline");
  const state = Y.encodeStateAsUpdate(doc);
  await cache.save("scope", state, { id: "one", update: state });
  await cache.save("scope", state, { id: "two", update: state });
  await cache.close();
  cache = new LocalCache(name);
  expect((await cache.pending("scope")).map((x) => x.id).sort()).toEqual([
    "one",
    "two",
  ]);
  await cache.ack("scope", "one");
  expect((await cache.pending("scope")).map((x) => x.id)).toEqual(["two"]);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, (await cache.state("scope"))!);
  expect(restored.getText("body").toString()).toBe("offline");
  expect(await cache.pending("other")).toEqual([]);
  await cache.clear("scope");
  expect(await cache.state("scope")).toBeUndefined();
  expect(await cache.pending("scope")).toEqual([]);
  await cache.close();
  doc.destroy();
  restored.destroy();
});
it("two tabs cannot overwrite each other’s persisted CRDT state", async () => {
  const name = "tabs-" + crypto.randomUUID();
  const first = new LocalCache(name),
    second = new LocalCache(name);
  const a = new Y.Doc(),
    b = new Y.Doc();
  a.getText("body").insert(0, "alpha");
  b.getText("body").insert(0, "beta");
  await Promise.all([
    first.save("same", Y.encodeStateAsUpdate(a)),
    second.save("same", Y.encodeStateAsUpdate(b)),
  ]);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, (await first.state("same"))!);
  expect(restored.getText("body").toString()).toContain("alpha");
  expect(restored.getText("body").toString()).toContain("beta");
  await first.close();
  await second.close();
  a.destroy();
  b.destroy();
  restored.destroy();
});
