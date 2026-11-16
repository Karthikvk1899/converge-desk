import { Worker } from "node:worker_threads";
export class MergePool {
  private active = 0;
  private stopped = false;
  private workers = new Set<Worker>();
  async run(
    base: Uint8Array,
    update: Uint8Array,
  ): Promise<{ state: Uint8Array; body: string }> {
    // No unbounded work queue: reject excess concurrent parse work before allocation.
    if (this.stopped || this.active >= 4)
      throw Object.assign(new Error("merge capacity busy"), {
        statusCode: 503,
      });
    this.active++;
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./merge-worker.ts", import.meta.url), {
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      this.workers.add(worker);
      let settled = false;
      const finish = (
        error: Error | null,
        result?: { state: Uint8Array; body: string },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active--;
        this.workers.delete(worker);
        void worker.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(
        () =>
          finish(
            Object.assign(new Error("update validation timeout"), {
              statusCode: 422,
            }),
          ),
        2500,
      );
      worker.on("message", (data) =>
        data.ok
          ? finish(null, { state: new Uint8Array(data.state), body: data.body })
          : finish(
              Object.assign(new Error("invalid or oversized CRDT update"), {
                statusCode: 422,
              }),
            ),
      );
      worker.on("error", () =>
        finish(
          Object.assign(new Error("update validation failed"), {
            statusCode: 422,
          }),
        ),
      );
      worker.on("exit", () => {
        if (!settled)
          finish(
            Object.assign(new Error("validation worker exited"), {
              statusCode: 503,
            }),
          );
      });
      worker.postMessage({ base, update });
    });
  }
  async close() {
    this.stopped = true;
    await Promise.all([...this.workers].map((w) => w.terminate()));
  }
}
