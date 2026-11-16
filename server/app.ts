import Fastify, { type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "redis";
import { z, ZodError } from "zod";
import {
  newPrincipal,
  newDocument,
  newCheckpoint,
  type Principal,
} from "../shared/protocol.ts";
import { Store, fail, hash } from "./store.ts";
import { attachSocket } from "./socket.ts";
import type { config } from "./config.ts";

declare module "fastify" {
  interface FastifyRequest {
    identity?: { actor: Principal; document: string };
  }
}
export function jsonSchema(schema: z.ZodType) {
  const result = z.toJSONSchema(schema, { target: "draft-7" });
  delete result.$schema;
  return result;
}
export async function build(cfg: ReturnType<typeof config>, connect = true) {
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    requestTimeout: 10000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const store = new Store(cfg.db);
  const redis = createClient({
    url: cfg.redis,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries) => Math.min(250 * retries, 2000),
    },
  });
  const subscriber = redis.duplicate();
  redis.on("error", () => {});
  subscriber.on("error", () => {});
  const rooms = new Map<string, Set<() => void>>();
  await app.register(swagger, {
    openapi: {
      info: { title: "Converge Desk", version: "0.1.0" },
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      },
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: 60000 });
  await app.register(websocket, {
    options: { maxPayload: 65536, perMessageDeflate: false },
  });
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    const status =
      error instanceof ZodError
        ? 422
        : e.statusCode && e.statusCode < 500
          ? e.statusCode
          : 503;
    reply.code(status).send({
      error:
        status < 500 ? e.message : "service unavailable; retry with backoff",
    });
  });
  const auth = async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || header.length > 512)
      fail(401, "bearer credential required");
    return store.byToken(header.slice(7));
  };
  const admin = async (req: FastifyRequest) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (
      !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(cfg.admin)))
    )
      fail(403, "administrator credential required");
  };
  const id = (req: FastifyRequest) =>
    z.uuid().parse((req.params as { id: string }).id);
  const secured = { security: [{ bearer: [] }] };
  app.post(
    "/admin/principals",
    { schema: { body: jsonSchema(newPrincipal) } },
    async (req, reply) => {
      await admin(req);
      const data = newPrincipal.parse(req.body);
      const token = randomBytes(40).toString("base64url");
      const ident = randomUUID();
      await store.pool.query(
        "INSERT INTO principals(id,tenant,name,role,token_hash) VALUES($1,$2,$3,$4,$5)",
        [ident, data.tenant, data.name, data.role, hash(token)],
      );
      return reply.code(201).send({ id: ident, token, ...data });
    },
  );
  app.delete("/admin/principals/:id", async (req, reply) => {
    await admin(req);
    await store.pool.query("UPDATE principals SET revoked=true WHERE id=$1", [
      id(req),
    ]);
    return reply.code(204).send();
  });
  app.get("/api/me", { schema: secured }, async (req) => auth(req));
  app.post(
    "/api/documents",
    { schema: { ...secured, body: jsonSchema(newDocument) } },
    async (req, reply) => {
      const actor = await auth(req);
      const body = newDocument.parse(req.body);
      return reply
        .code(201)
        .send(await store.create(actor, body.title, body.body));
    },
  );
  app.get("/api/documents", { schema: secured }, async (req) => {
    const actor = await auth(req);
    const query = z
      .object({ q: z.string().max(120).default("") })
      .parse(req.query);
    const { rows } = await store.pool.query(
      `SELECT id,title,seq::float8,updated_at,length(content) AS characters FROM documents
    WHERE tenant=$1 AND ($2='' OR search @@ plainto_tsquery('simple',$2))
    ORDER BY updated_at DESC,id LIMIT 50`,
      [actor.tenant, query.q],
    );
    return rows;
  });
  app.get("/api/documents/:id", { schema: secured }, async (req) => {
    const actor = await auth(req);
    return store.transaction(async (db) => {
      await store.actor(db, actor.id);
      const d = await store.document(db, actor.tenant, id(req));
      return {
        id: d.id,
        title: d.title,
        seq: Number(d.seq),
        body: d.content,
        state: d.state.toString("base64"),
        updated_at: d.updated_at,
      };
    });
  });
  app.post("/api/documents/:id/tickets", { schema: secured }, async (req) => {
    const actor = await auth(req);
    const document = id(req);
    await store.transaction(async (db) => {
      await store.actor(db, actor.id);
      await store.document(db, actor.tenant, document);
    });
    const ticket = randomBytes(32).toString("base64url");
    await redis.set(
      "ticket:" + hash(ticket),
      JSON.stringify({ principal: actor.id, document }),
      { EX: 30, NX: true },
    );
    return { ticket, expires_in: 30 };
  });
  app.get("/api/documents/:id/history", { schema: secured }, async (req) => {
    const actor = await auth(req);
    return store.transaction(async (db) => {
      await store.actor(db, actor.id);
      await store.document(db, actor.tenant, id(req));
      return (
        await db.query(
          "SELECT u.seq::float8,u.op_id,u.digest,u.created_at,p.name AS actor FROM updates u JOIN principals p ON p.id=u.actor WHERE document_id=$1 ORDER BY u.seq DESC LIMIT 50",
          [id(req)],
        )
      ).rows;
    });
  });
  app.post(
    "/api/documents/:id/checkpoints",
    { schema: { ...secured, body: jsonSchema(newCheckpoint) } },
    async (req, reply) => {
      const actor = await auth(req);
      const body = newCheckpoint.parse(req.body);
      const result = await store.transaction(async (db) => {
        await store.actor(db, actor.id, true);
        const doc = await store.document(db, actor.tenant, id(req), true);
        if (Number(doc.seq) !== body.expected_seq)
          fail(409, "document changed; synchronize before checkpointing");
        const ident = randomUUID();
        await db.query(
          "INSERT INTO checkpoints(id,document_id,tenant,label,seq,content,actor) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            ident,
            doc.id,
            actor.tenant,
            body.label,
            doc.seq,
            doc.content,
            actor.id,
          ],
        );
        return { id: ident, seq: Number(doc.seq), label: body.label };
      });
      return reply.code(201).send(result);
    },
  );
  app.get(
    "/api/documents/:id/checkpoints",
    { schema: secured },
    async (req) => {
      const actor = await auth(req);
      return store.transaction(async (db) => {
        await store.actor(db, actor.id);
        await store.document(db, actor.tenant, id(req));
        return (
          await db.query(
            "SELECT c.id,c.label,c.seq::float8,c.created_at,p.name AS actor FROM checkpoints c JOIN principals p ON p.id=c.actor WHERE document_id=$1 ORDER BY created_at DESC LIMIT 50",
            [id(req)],
          )
        ).rows;
      });
    },
  );
  app.post(
    "/api/checkpoints/:id/fork",
    {
      schema: {
        ...secured,
        body: jsonSchema(z.object({ title: newDocument.shape.title }).strict()),
      },
    },
    async (req, reply) => {
      const actor = await auth(req);
      const body = z
        .object({ title: newDocument.shape.title })
        .strict()
        .parse(req.body);
      const { rows } = await store.pool.query(
        "SELECT content FROM checkpoints WHERE id=$1 AND tenant=$2",
        [id(req), actor.tenant],
      );
      if (!rows.length) fail(404, "checkpoint not found");
      return reply
        .code(201)
        .send(await store.create(actor, body.title, rows[0].content));
    },
  );
  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (req) => {
        if (req.headers.origin !== cfg.origin) fail(403, "origin not allowed");
        const { ticket } = z
          .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .strict()
          .parse(req.query);
        const value = await redis.getDel("ticket:" + hash(ticket));
        if (!value) fail(401, "ticket expired or already used");
        const claim = JSON.parse(value) as {
          principal: string;
          document: string;
        };
        const actor = await store.transaction(async (db) => {
          const actor = await store.actor(db, claim.principal);
          await store.document(db, actor.tenant, claim.document);
          return actor;
        });
        req.identity = { actor, document: claim.document };
      },
    },
    (socket, req) =>
      attachSocket(socket, req.identity!, {
        store,
        redis,
        rooms,
        instance: cfg.instance,
      }),
  );
  app.get("/health/live", async () => ({
    status: "up",
    instance: cfg.instance,
  }));
  app.get("/health/ready", async () => {
    await store.pool.query(
      "SELECT version FROM schema_version WHERE version=1",
    );
    await redis.ping();
    return { status: "ready" };
  });
  app.get("/api/openapi.json", { schema: secured }, async (req) => {
    await auth(req);
    return app.swagger();
  });
  if (connect) {
    await redis.connect();
    await subscriber.connect();
    await subscriber.subscribe("desk:changes", (message) => {
      for (const wake of rooms.get(message) ?? []) wake();
    });
  }
  app.addHook("onClose", async () => {
    await store.close();
    if (subscriber.isOpen) subscriber.destroy();
    if (redis.isOpen) redis.destroy();
  });
  return { app, store, redis };
}
