import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

import {
  MAX_UPDATE,
  writeMessage,
  type Principal,
  type ServerMessage,
} from "../shared/protocol.ts";
import { Store, fail } from "./store.ts";
const presenceScript = `local t=redis.call('TIME');local n=t[1]*1000+math.floor(t[2]/1000);redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',n-15000);redis.call('ZADD',KEYS[1],n,ARGV[1]);redis.call('EXPIRE',KEYS[1],30);return redis.call('ZRANGE',KEYS[1],0,-1)`;
let connections = 0;
export function attachSocket(
  socket: WebSocket,
  identity: { actor: Principal; document: string },
  deps: {
    store: Store;
    redis: {
      publish: (channel: string, message: string) => Promise<unknown>;
      zRem: (key: string, member: string) => Promise<unknown>;
      eval: (
        script: string,
        options: { keys: string[]; arguments: string[] },
      ) => Promise<unknown>;
    };
    rooms: Map<string, Set<() => void>>;
    instance: string;
  },
) {
  const { actor, document } = identity;
  const { store, redis, rooms } = deps;
  if (connections >= 100) {
    socket.close(1013, "instance capacity");
    return;
  }
  connections++;
  const member = JSON.stringify({
    id: actor.id,
    name: actor.name,
    session: randomUUID(),
  });
  const presenceKey = "presence:" + document;
  let cursor = 0,
    closed = false,
    pumping = false,
    queued = 0,
    credits = 30,
    lastRefill = Date.now(),
    alive = true;
  const send = (message: ServerMessage) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1048576) {
      socket.close(1013, "slow consumer; reconnect");
      return;
    }
    socket.send(JSON.stringify(message));
  };
  const report = (e: unknown, op_id?: string) => {
    const error = e as Error & { statusCode?: number };
    const code = error.statusCode ?? 503;
    send({
      type: "error",
      code: String(code),
      message:
        code < 500
          ? error.message
          : "temporarily unavailable; edit retained locally",
      retryable: code >= 500,
      op_id,
    });
    if (code === 401 || code === 403 || code === 404)
      socket.close(4403, "access no longer permitted");
  };
  const ready = store.transaction(async (db) => {
    await store.actor(db, actor.id);
    const doc = await store.document(db, actor.tenant, document);
    cursor = Number(doc.seq);
    send({
      type: "hello",
      version: 1,
      seq: cursor,
      state: doc.state.toString("base64"),
      role: actor.role,
      instance: deps.instance,
    });
  });
  let chain = ready.catch((e) => {
    report(e);
    socket.close(1013, "snapshot unavailable");
  });
  const pump = async () => {
    if (closed || pumping) return;
    pumping = true;
    try {
      await ready;
      const rows = await store.transaction(async (db) => {
        await store.actor(db, actor.id);
        return (
          await db.query(
            "SELECT u.seq,u.payload,u.op_id,p.name AS actor FROM updates u JOIN principals p ON p.id=u.actor JOIN documents d ON d.id=u.document_id WHERE u.document_id=$1 AND d.tenant=$2 AND u.seq>$3 ORDER BY u.seq LIMIT 100",
            [document, actor.tenant, cursor],
          )
        ).rows;
      });
      for (const row of rows) {
        send({
          type: "patch",
          seq: Number(row.seq),
          update: row.payload.toString("base64"),
          op_id: row.op_id,
          actor: row.actor,
        });
        cursor = Number(row.seq);
      }
      try {
        const roster = (await redis.eval(presenceScript, {
          keys: [presenceKey],
          arguments: [member],
        })) as string[];
        const unique = new Map<string, { id: string; name: string }>();
        for (const entry of roster) {
          const person = JSON.parse(entry);
          unique.set(person.id, { id: person.id, name: person.name });
        }
        send({ type: "presence", actors: [...unique.values()] });
      } catch {
        send({ type: "presence", actors: [] });
      }
    } catch (e) {
      report(e);
    } finally {
      pumping = false;
    }
  };
  const wake = () => {
    void pump();
  };
  const set = rooms.get(document) ?? new Set();
  set.add(wake);
  rooms.set(document, set);
  const timer = setInterval(wake, 2000);
  void ready.then(wake).catch(() => {});
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 15000);
  socket.on("pong", () => {
    alive = true;
  });
  socket.on("message", (data, isBinary) => {
    const now = Date.now();
    credits = Math.min(30, credits + ((now - lastRefill) / 1000) * 10);
    lastRefill = now;
    if (
      isBinary ||
      !Buffer.isBuffer(data) ||
      data.length > 45000 ||
      queued >= 16 ||
      credits < 1
    ) {
      socket.close(1008, "message budget exceeded");
      return;
    }
    credits--;
    queued++;
    chain = chain
      .then(async () => {
        if (closed) return;
        let op: string | undefined;
        try {
          const msg = writeMessage.parse(JSON.parse(data.toString()));
          op = msg.op_id;
          const payload = Buffer.from(msg.update, "base64");
          if (
            payload.length > MAX_UPDATE ||
            !payload.length ||
            payload.toString("base64") !== msg.update
          )
            fail(422, "invalid update encoding or size");
          const result = await store.write(actor, document, msg.op_id, payload);
          send({ type: "ack", op_id: msg.op_id, ...result });
          // Delivery hints are best effort. Database polling repairs dropped notifications.
          void redis.publish("desk:changes", document).catch(() => {});
          wake();
        } catch (e) {
          if (e instanceof SyntaxError)
            report(
              Object.assign(new Error("invalid JSON"), { statusCode: 422 }),
              op,
            );
          else if ((e as Error).name === "ZodError")
            report(
              Object.assign(new Error("invalid update envelope"), {
                statusCode: 422,
              }),
              op,
            );
          else report(e, op);
        }
      })
      .finally(() => {
        queued--;
      });
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
    connections--;
    clearInterval(timer);
    clearInterval(heartbeat);
    set.delete(wake);
    if (!set.size) rooms.delete(document);
    void redis.zRem(presenceKey, member).catch(() => {});
  });
}
