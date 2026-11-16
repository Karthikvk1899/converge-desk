import { openDB, type IDBPDatabase } from "idb";
import * as Y from "yjs";
export type Pending = {
  scope: string;
  id: string;
  update: Uint8Array;
  created: number;
};
export class LocalCache {
  private db: Promise<IDBPDatabase>;
  constructor(name = "converge-desk-v1") {
    this.db = openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("state");
        const outbox = db.createObjectStore("outbox", {
          keyPath: ["scope", "id"],
        });
        outbox.createIndex("scope", "scope");
      },
    });
  }
  async state(scope: string): Promise<Uint8Array | undefined> {
    return (await this.db).get("state", scope);
  }
  async pending(scope: string): Promise<Pending[]> {
    return (
      await (await this.db).getAllFromIndex("outbox", "scope", scope)
    ).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  }
  async save(
    scope: string,
    state: Uint8Array,
    operation?: { id: string; update: Uint8Array },
  ) {
    const tx = (await this.db).transaction(["state", "outbox"], "readwrite");
    const previous = await tx.objectStore("state").get(scope);
    // Merge with persisted state: two tabs cannot overwrite each other's offline CRDT state.
    const merged = previous ? Y.mergeUpdates([previous, state]) : state;
    await tx.objectStore("state").put(merged, scope);
    if (operation)
      await tx
        .objectStore("outbox")
        .put({ scope, ...operation, created: Date.now() });
    await tx.done;
  }
  async ack(scope: string, id: string) {
    await (await this.db).delete("outbox", [scope, id]);
  }
  async clear(scope: string) {
    const tx = (await this.db).transaction(["state", "outbox"], "readwrite");
    await tx.objectStore("state").delete(scope);
    for (const key of await tx
      .objectStore("outbox")
      .index("scope")
      .getAllKeys(scope))
      await tx.objectStore("outbox").delete(key);
    await tx.done;
  }
  async close() {
    (await this.db).close();
  }
}
