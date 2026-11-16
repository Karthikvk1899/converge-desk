import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { initial, merge } from "../server/merge.ts";
import { MergePool } from "../server/workers.ts";
function text(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const result = doc.getText("body").toString();
  doc.destroy();
  return result;
}
function edit(base: Uint8Array, value: string) {
  const d = new Y.Doc();
  Y.applyUpdate(d, base);
  const updates: Uint8Array[] = [];
  d.on("update", (u: Uint8Array) => updates.push(u));
  d.getText("body").insert(0, value);
  d.destroy();
  return updates[0];
}
describe("CRDT persistence boundary", () => {
  it("merges concurrent edits in either order with idempotent replay", () => {
    const base = initial("runbook");
    const a = edit(base, "alpha "),
      b = edit(base, "beta ");
    const ab = merge(merge(base, a).state, b);
    const ba = merge(merge(base, b).state, a);
    expect(ab.body).toBe(ba.body);
    expect(ab.body).toContain("alpha ");
    expect(ab.body).toContain("beta ");
    expect(merge(ab.state, a).body).toBe(ab.body);
  });
  it("preserves out-of-order causal updates across persisted snapshots", () => {
    const base = initial("");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base);
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    doc.getText("body").insert(0, "hello");
    doc.getText("body").insert(5, " world");
    const pending = merge(base, updates[1]);
    const completed = merge(pending.state, updates[0]);
    expect(completed.body).toBe("hello world");
    doc.destroy();
  });
  it("concurrent deletion and insertion converge", () => {
    const base = initial("abc");
    const a = new Y.Doc(),
      b = new Y.Doc();
    Y.applyUpdate(a, base);
    Y.applyUpdate(b, base);
    a.getText("body").delete(1, 1);
    b.getText("body").insert(1, "X");
    expect(merge(Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b)).body).toBe(
      merge(Y.encodeStateAsUpdate(b), Y.encodeStateAsUpdate(a)).body,
    );
    a.destroy();
    b.destroy();
  });
  it("rejects additional roots, rich embeds, attributes, malformed updates and size excess", () => {
    const bad = new Y.Doc();
    bad.getMap("secrets").set("x", "y");
    expect(() => merge(initial(""), Y.encodeStateAsUpdate(bad))).toThrow();
    bad.destroy();
    const embed = new Y.Doc();
    embed.getText("body").insertEmbed(0, { html: "<script>" });
    expect(() => merge(initial(""), Y.encodeStateAsUpdate(embed))).toThrow();
    embed.destroy();
    const rich = new Y.Doc();
    rich.getText("body").insert(0, "x", { bold: true });
    expect(() => merge(initial(""), Y.encodeStateAsUpdate(rich))).toThrow();
    rich.destroy();
    for (const payload of [new Uint8Array([255, 255]), new Uint8Array(32769)])
      expect(() => merge(initial(""), payload)).toThrow();
  });
  it("enforces total visible text bound independently of update size", () => {
    const base = initial("x".repeat(100000));
    expect(() => merge(base, edit(base, "a"))).toThrow("capacity");
  });
  it("isolates binary decoding in a bounded worker", async () => {
    const pool = new MergePool();
    try {
      const base = initial("hello");
      const result = await pool.run(base, edit(base, "safe "));
      expect(text(result.state)).toBe("safe hello");
      await expect(pool.run(base, new Uint8Array([255]))).rejects.toThrow(
        "invalid",
      );
    } finally {
      await pool.close();
    }
  });
});

it("rejects NUL text before it can enter a PostgreSQL retry loop", () => {
  const base = initial("valid");
  expect(() => merge(base, edit(base, "bad\0text"))).toThrow("NUL");
  expect(() => initial("bad\0text")).toThrow("invalid document text");
});
