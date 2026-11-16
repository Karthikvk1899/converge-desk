import { parentPort } from "node:worker_threads";
import { merge } from "./merge.ts";
parentPort!.on(
  "message",
  ({ base, update }: { base: Uint8Array; update: Uint8Array }) => {
    try {
      parentPort!.postMessage({ ok: true, ...merge(base, update) });
    } catch {
      parentPort!.postMessage({ ok: false });
    }
  },
);
