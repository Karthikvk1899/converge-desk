import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Principal } from "../shared/protocol.ts";
import { initial } from "./merge.ts";
import { MergePool } from "./workers.ts";
export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export class Store {
  pool: Pool;
  merges = new MergePool();
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 5000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 10000,
    });
    this.pool.on("error", () => {});
  }
  async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }
  async byToken(token: string): Promise<Principal> {
    const { rows } = await this.pool.query(
      "SELECT id,tenant,name,role FROM principals WHERE token_hash=$1 AND NOT revoked",
      [hash(token)],
    );
    return rows[0] ?? fail(401, "invalid or revoked credential");
  }
  async actor(db: PoolClient, id: string, write = false): Promise<Principal> {
    const { rows } = await db.query(
      "SELECT id,tenant,name,role FROM principals WHERE id=$1 AND NOT revoked FOR SHARE",
      [id],
    );
    const actor: Principal = rows[0] ?? fail(401, "credential revoked");
    if (write && actor.role !== "editor") fail(403, "editor role required");
    return actor;
  }
  async document(db: PoolClient, tenant: string, id: string, lock = false) {
    const { rows } = await db.query(
      lock
        ? "SELECT * FROM documents WHERE tenant=$1 AND id=$2 FOR UPDATE"
        : "SELECT * FROM documents WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ?? fail(404, "document not found");
  }
  async create(actor: Principal, title: string, body: string) {
    const state = initial(body);
    return this.transaction(async (db) => {
      const current = await this.actor(db, actor.id, true);
      const id = randomUUID();
      await db.query(
        "INSERT INTO documents(id,tenant,title,state,content,author) VALUES($1,$2,$3,$4,$5,$6)",
        [id, current.tenant, title, Buffer.from(state), body, current.id],
      );
      return { id, title, seq: 0 };
    });
  }
  async write(
    actor: Principal,
    document: string,
    opId: string,
    payload: Uint8Array,
  ) {
    return this.transaction(async (db) => {
      const current = await this.actor(db, actor.id, true);
      const doc = await this.document(db, current.tenant, document, true);
      const digest = hash(payload);
      const { rows } = await db.query(
        "SELECT seq,digest,actor FROM updates WHERE document_id=$1 AND op_id=$2",
        [document, opId],
      );
      if (rows.length) {
        if (rows[0].digest !== digest || rows[0].actor !== actor.id)
          fail(409, "operation ID conflict");
        return { seq: Number(rows[0].seq), duplicate: true };
      }
      const merged = await this.merges.run(new Uint8Array(doc.state), payload);
      const seq = Number(doc.seq) + 1;
      await db.query(
        "INSERT INTO updates(document_id,op_id,seq,actor,digest,payload) VALUES($1,$2,$3,$4,$5,$6)",
        [document, opId, seq, actor.id, digest, Buffer.from(payload)],
      );
      await db.query(
        "UPDATE documents SET state=$1,content=$2,seq=$3,updated_at=now() WHERE id=$4",
        [Buffer.from(merged.state), merged.body, seq, document],
      );
      return { seq, duplicate: false };
    });
  }
  async close() {
    await this.merges.close();
    await this.pool.end();
  }
}
