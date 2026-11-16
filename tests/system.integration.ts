import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  principal,
  create,
  request,
  Peer,
  until,
  API_A,
  API_B,
  deniedSocket,
} from "./client.ts";
const peers: Peer[] = [];
afterEach(() => {
  for (const p of peers.splice(0)) p.close();
});
async function setup() {
  const tenant = "test-" + randomUUID().slice(0, 8);
  const a = await principal(tenant, "Alice"),
    b = await principal(tenant, "Bob");
  const d = await create(a.token);
  return { tenant, a, b, d };
}
async function join(token: string, id: string, base = API_A) {
  const p = await Peer.connect(token, id, base);
  peers.push(p);
  return p;
}
describe("two real replicas with PostgreSQL and Redis", () => {
  it("converges concurrent edits and deduplicates a lost-ack retry", async () => {
    const { a, b, d } = await setup();
    const left = await join(a.token, d.id),
      right = await join(b.token, d.id, API_B);
    const u = left.edit("alpha "),
      v = right.edit("beta ");
    const op = left.send(u),
      other = right.send(v);
    await Promise.all([left.ack(op), right.ack(other)]);
    await until(
      () =>
        left.text() === right.text() &&
        left.text().includes("alpha") &&
        left.text().includes("beta"),
    );
    const ack = await left.ack(op);
    left.events = [];
    left.send(u, op);
    expect((await left.ack(op)).seq).toBe(ack.seq);
    expect((await left.ack(op)).duplicate).toBe(true);
    const saved = await (
      await request("/api/documents/" + d.id, a.token)
    ).json();
    expect(saved.body).toBe(left.text());
    expect(saved.seq).toBe(2);
  });
  it("rejects operation-ID content conflicts and malformed update bytes without advancing sequence", async () => {
    const { a, d } = await setup();
    const p = await join(a.token, d.id);
    const op = p.send(p.edit("first"));
    await p.ack(op);
    p.send(p.edit("second"), op);
    await until(() =>
      p.events.find((e) => e.type === "error" && e.code === "409"),
    );
    p.send(new Uint8Array([255]), randomUUID());
    await until(() =>
      p.events.find((e) => e.type === "error" && e.code === "422"),
    );
    const saved = await (
      await request("/api/documents/" + d.id, a.token)
    ).json();
    expect(saved.seq).toBe(1);
    expect(saved.body).toBe("first");
  });
  it("enforces viewer permissions, tenant isolation and administrative separation", async () => {
    const { tenant, a, d } = await setup();
    const viewer = await principal(tenant, "Reader", "viewer");
    const outsider = await principal(
      "other-" + randomUUID().slice(0, 8),
      "Other",
    );
    expect(
      (await request("/api/documents/" + d.id, outsider.token)).status,
    ).toBe(404);
    expect(
      (await request(`/api/documents/${d.id}/tickets`, outsider.token, "POST"))
        .status,
    ).toBe(404);
    expect(
      (await request("/api/documents", viewer.token, "POST", { title: "no" }))
        .status,
    ).toBe(403);
    expect((await request("/api/me", process.env.ADMIN_KEY!)).status).toBe(401);
    const p = await join(viewer.token, d.id);
    p.send(p.edit("forbidden"));
    await until(() =>
      p.events.find((e) => e.type === "error" && e.code === "403"),
    );
    expect(
      (await (await request("/api/documents/" + d.id, a.token)).json()).seq,
    ).toBe(0);
  });
  it("uses one-time tickets, checks Origin and rechecks revocation on existing sockets", async () => {
    const { a, d } = await setup();
    const r = await request(`/api/documents/${d.id}/tickets`, a.token, "POST");
    const { ticket } = await r.json();
    const url = API_A.replace(/^http/, "ws") + "/ws?ticket=" + ticket;
    expect(await deniedSocket(url, "https://evil.example")).toBe(403);
    const p = new Peer(url);
    peers.push(p);
    await until(() => p.events.find((e) => e.type === "hello"));
    expect(await deniedSocket(url)).toBe(401);
    expect(
      (
        await request(
          "/admin/principals/" + a.id,
          process.env.ADMIN_KEY!,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    await until(() => p.closed);
    expect((await request("/api/me", a.token)).status).toBe(401);
  });
  it("checkpoints exact committed content, rejects stale sequence, and forks without rewriting history", async () => {
    const { a, d } = await setup();
    const p = await join(a.token, d.id);
    await p.ack(p.send(p.edit("milestone")));
    expect(
      (
        await request(`/api/documents/${d.id}/checkpoints`, a.token, "POST", {
          label: "stale",
          expected_seq: 0,
        })
      ).status,
    ).toBe(409);
    const r = await request(
      `/api/documents/${d.id}/checkpoints`,
      a.token,
      "POST",
      { label: "reviewed", expected_seq: 1 },
    );
    expect(r.status).toBe(201);
    const checkpoint = await r.json();
    await p.ack(p.send(p.edit(" later")));
    const fork = await request(
      `/api/checkpoints/${checkpoint.id}/fork`,
      a.token,
      "POST",
      { title: "Recovery copy" },
    );
    expect(fork.status).toBe(201);
    const cloned = await fork.json();
    expect(
      (await (await request("/api/documents/" + cloned.id, a.token)).json())
        .body,
    ).toBe("milestone");
    expect(
      (await (await request("/api/documents/" + d.id, a.token)).json()).body,
    ).toBe("milestone later");
  });
  it("indexes committed content for tenant-scoped search and preserves ordered audit metadata", async () => {
    const { a, d } = await setup();
    const p = await join(a.token, d.id);
    await p.ack(p.send(p.edit("quasarfix investigation")));
    const results = await (
      await request("/api/documents?q=quasarfix", a.token)
    ).json();
    expect(results.map((x: { id: string }) => x.id)).toContain(d.id);
    const history = await (
      await request(`/api/documents/${d.id}/history`, a.token)
    ).json();
    expect(history[0].actor).toBe("Alice");
    expect(history[0].seq).toBe(1);
    expect(history[0]).not.toHaveProperty("payload");
  });
});
