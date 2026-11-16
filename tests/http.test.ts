import { it, expect, afterAll } from "vitest";
import { build } from "../server/app.ts";
const { app } = await build(
  {
    admin: "x".repeat(40),
    origin: "http://localhost:3000",
    port: 8080,
    instance: "test",
    db: "postgresql://unused",
    redis: "redis://localhost:6379",
  },
  false,
);
afterAll(() => app.close());
it("rejects missing authentication and protects administrative provisioning", async () => {
  expect((await app.inject({ url: "/api/me" })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/admin/principals",
        payload: { tenant: "demo", name: "Alice", role: "editor" },
      })
    ).statusCode,
  ).toBe(403);
});
it("enforces actual payload limit, strict shape and defensive headers", async () => {
  const oversized = await app.inject({
    method: "POST",
    url: "/api/documents",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ title: "t", body: "x".repeat(65537) }),
  });
  expect(oversized.statusCode).toBe(413);
  const unknown = await app.inject({
    method: "POST",
    url: "/api/documents",
    payload: { title: "t", admin: true },
  });
  expect(unknown.statusCode).toBe(400);
  expect(unknown.headers["cache-control"]).toBe("no-store");
  expect(unknown.headers["x-content-type-options"]).toBe("nosniff");
});

it("rejects NUL-bearing document content and titles at the HTTP boundary", async () => {
  for (const payload of [
    { title: "bad\0title" },
    { title: "valid", body: "bad\0body" },
  ]) {
    expect(
      (await app.inject({ method: "POST", url: "/api/documents", payload }))
        .statusCode,
    ).toBe(400);
  }
});
