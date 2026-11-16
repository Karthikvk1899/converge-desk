// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sync } from "../web/sync.ts";
import type { ServerMessage } from "../shared/protocol.ts";
vi.mock("../web/cache.ts", () => ({
  LocalCache: class {
    entries: { id: string; update: Uint8Array }[] = [];
    state = vi.fn(async () => undefined);
    pending = vi.fn(async () => this.entries.slice());
    save = vi.fn(
      async (
        _scope: string,
        _state: Uint8Array,
        op?: { id: string; update: Uint8Array },
      ) => {
        if (op) this.entries.push(op);
      },
    );
    ack = vi.fn(async (_scope: string, id: string) => {
      this.entries = this.entries.filter((x) => x.id !== id);
    });
    close = vi.fn(async () => {});
  },
}));
class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  constructor() {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(message: ServerMessage) {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
let provider: Sync;
beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "test" }) })),
  );
  provider = new Sync(
    { id: "actor", tenant: "tenant", name: "Alice", role: "editor" },
    "doc",
    "token",
    () => {},
  );
});
afterEach(async () => {
  await provider.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function socket() {
  await provider.start();
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  return Socket.instances[0];
}
it("does not wait for a stalled ticket request before allowing local editing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    ),
  );
  await provider.start();
  provider.doc.getText("body").insert(0, "recoverable offline work");
  await vi.waitFor(() => expect(provider.state.pending).toBe(1));
  expect(provider.state.durable).toBe(true);
});
it("keeps a terminally rejected edit blocked through offline and online transitions", async () => {
  const ws = await socket();
  provider.doc.getText("body").insert(0, "retained");
  await vi.waitFor(() => expect(provider.state.pending).toBe(1));
  ws.receive({
    type: "error",
    code: "422",
    message: "state limit",
    retryable: false,
    op_id: "rejected",
  });
  await vi.waitFor(() => expect(provider.state.status).toBe("blocked"));
  window.dispatchEvent(new Event("offline"));
  window.dispatchEvent(new Event("online"));
  await provider.connect();
  expect(provider.state.status).toBe("blocked");
  expect(provider.state.pending).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("never creates a second live socket for repeated connection requests", async () => {
  await socket();
  await provider.connect();
  window.dispatchEvent(new Event("online"));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(Socket.instances).toHaveLength(1);
});
it("closes a handshake that never sends its initial snapshot", async () => {
  vi.useFakeTimers();
  await provider.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(Socket.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10001);
  expect(Socket.instances[0].readyState).toBe(3);
  expect(provider.state.status).toBe("offline");
});
it("keeps a storage failure visible and blocks transmission even after subsequent successful saves", async () => {
  await socket();
  vi.mocked(provider.cache.save).mockRejectedValueOnce(new Error("quota"));
  provider.doc.getText("body").insert(0, "not persisted");
  await vi.waitFor(() => expect(provider.state.status).toBe("blocked"));
  provider.doc.getText("body").insert(0, "another update");
  await vi.waitFor(() => expect(provider.cache.save).toHaveBeenCalledTimes(2));
  expect(provider.state.durable).toBe(false);
  expect(provider.state.error).toContain("Local storage failed");
  expect(Socket.instances[0].send).not.toHaveBeenCalled();
});

it("shuts down once when explicit close and component cleanup race", async () => {
  await socket();
  await Promise.all([provider.stop(), provider.stop()]);
  expect(provider.cache.close).toHaveBeenCalledTimes(1);
  expect(Socket.instances[0].readyState).toBe(3);
});
