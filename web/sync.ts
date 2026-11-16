import * as Y from "yjs";
import { LocalCache } from "./cache.ts";
import {
  fromBase64,
  toBase64,
  type Principal,
  type ServerMessage,
} from "../shared/protocol.ts";
export type SyncState = {
  status: "connecting" | "online" | "offline" | "blocked";
  pending: number;
  seq: number;
  instance: string;
  error: string;
  actors: { id: string; name: string }[];
  durable: boolean;
};
export class Sync {
  doc = new Y.Doc();
  cache = new LocalCache();
  scope: string;
  state: SyncState = {
    status: "connecting",
    pending: 0,
    seq: 0,
    instance: "",
    error: "",
    actors: [],
    durable: true,
  };
  private stopped = false;
  private stopWork: Promise<void> | undefined;
  private pendingSaves = 0;
  private storageFailed = false;
  private opening: AbortController | undefined;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private socket: WebSocket | null = null;
  private work = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private connecting = false;
  private initialized = false;
  private inflight = new Map<string, number>();
  private failed = new Set<string>();
  private onChange: () => void;
  private offline = () => {
    this.socket?.close();
    if (this.state.status !== "blocked") this.state.status = "offline";
    this.emit();
  };
  private online = () => {
    void this.connect();
  };
  constructor(
    private actor: Principal,
    private id: string,
    private token: string,
    private notify: (state: SyncState) => void,
  ) {
    this.scope = actor.tenant + ":" + actor.id + ":" + id;
    this.onChange = () => this.emit();
  }
  private emit() {
    this.notify({ ...this.state, actors: [...this.state.actors] });
  }
  private enqueue(task: () => Promise<void>) {
    this.work = this.work.then(task).catch(() => {
      this.storageFailed = true;
      this.state.status = "blocked";
      this.state.durable = false;
      this.state.error =
        "Local storage failed. Export this document before closing the tab.";
      this.emit();
    });
    return this.work;
  }
  async start() {
    const cached = await this.cache.state(this.scope);
    if (this.stopped) return;
    window.addEventListener("offline", this.offline);
    window.addEventListener("online", this.online);
    if (cached) Y.applyUpdate(this.doc, cached, "bootstrap");
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const state = Y.encodeStateAsUpdate(this.doc);
      const local = origin !== "remote" && origin !== "bootstrap";
      const operation = local ? { id: crypto.randomUUID(), update } : undefined;
      this.pendingSaves++;
      this.state.durable = false;
      this.emit();
      void this.enqueue(async () => {
        await this.cache.save(this.scope, state, operation);
        this.pendingSaves--;
        this.state.durable = !this.storageFailed && this.pendingSaves === 0;
        await this.flush();
        this.emit();
      });
    });
    this.doc.getText("body").observe(this.onChange);
    this.state.pending = (await this.cache.pending(this.scope)).length;
    this.emit();
    this.heartbeat = setInterval(() => {
      void this.enqueue(() => this.flush());
      if (!this.socket || this.socket.readyState === 3) void this.connect();
    }, 3000);
    if (!navigator.onLine) this.state.status = "offline";
    this.emit();
    void this.connect();
  }
  async connect() {
    if (
      this.stopped ||
      this.connecting ||
      (this.socket !== null && this.socket.readyState < 2) ||
      this.state.status === "blocked" ||
      !navigator.onLine
    )
      return;
    this.connecting = true;
    this.state.status = "connecting";
    this.emit();
    this.opening = new AbortController();
    const deadline = setTimeout(() => this.opening?.abort(), 10000);
    try {
      const response = await fetch(`/api/documents/${this.id}/tickets`, {
        method: "POST",
        signal: this.opening.signal,
        headers: { Authorization: "Bearer " + this.token },
      });
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          this.state.status = "blocked";
          this.state.error =
            "Access denied. Export local work, then reconnect with an authorized credential.";
          this.emit();
          return;
        }
        throw new Error("offline");
      }
      const { ticket } = await response.json();
      if (this.stopped) return;
      const url = new URL("/ws", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      const socket = new WebSocket(url);
      this.socket = socket;
      this.initialized = false;
      this.handshake = setTimeout(() => {
        if (this.socket === socket && !this.initialized) socket.close();
      }, 10000);
      socket.onmessage = (e) => {
        void this.enqueue(async () => {
          if (this.stopped || this.socket !== socket) return;
          const message = JSON.parse(e.data) as ServerMessage;
          if (message.type === "hello") {
            clearTimeout(this.handshake);
            Y.applyUpdate(this.doc, fromBase64(message.state), "remote");
            this.state.seq = message.seq;
            this.state.instance = message.instance;
            this.initialized = true;
            if (this.state.status !== "blocked") {
              this.state.status = "online";
              this.state.error = "";
            }
            this.inflight.clear();
            await this.cache.save(this.scope, Y.encodeStateAsUpdate(this.doc));
            await this.flush();
          } else if (message.type === "patch") {
            if (message.seq > this.state.seq) {
              Y.applyUpdate(this.doc, fromBase64(message.update), "remote");
              this.state.seq = message.seq;
              await this.cache.save(
                this.scope,
                Y.encodeStateAsUpdate(this.doc),
              );
            }
          } else if (message.type === "ack") {
            await this.cache.ack(this.scope, message.op_id);
            if (this.state.status !== "blocked") this.state.error = "";
            this.inflight.delete(message.op_id);
            this.state.pending = (await this.cache.pending(this.scope)).length;
            clearTimeout(this.flushTimer);
            this.flushTimer = setTimeout(
              () => void this.enqueue(() => this.flush()),
              150,
            );
          } else if (message.type === "presence")
            this.state.actors = message.actors;
          else {
            this.state.error = message.message;
            if (message.op_id) this.inflight.delete(message.op_id);
            if (!message.retryable && message.op_id) {
              this.failed.add(message.op_id);
              this.state.status = "blocked";
            }
          }
          this.emit();
        });
      };
      socket.onclose = () => {
        if (this.socket !== socket || this.stopped) return;
        clearTimeout(this.handshake);
        this.initialized = false;
        this.socket = null;
        this.inflight.clear();
        if (this.state.status !== "blocked") this.state.status = "offline";
        this.emit();
        this.retry = setTimeout(
          () => void this.connect(),
          1500 + Math.random() * 1000,
        );
      };
      socket.onerror = () => socket.close();
    } catch {
      if (this.state.status !== "blocked") this.state.status = "offline";
      this.emit();
    } finally {
      clearTimeout(deadline);
      this.opening = undefined;
      this.connecting = false;
    }
  }
  private async flush() {
    const pending = await this.cache.pending(this.scope);
    this.state.pending = pending.length;
    if (
      !this.initialized ||
      this.socket?.readyState !== 1 ||
      this.stopped ||
      this.state.status === "blocked"
    )
      return;
    // One in-flight operation bounds server pressure; Yjs tolerates reordered retries.
    const first = pending.find((p) => !this.failed.has(p.id));
    if (!first) return;
    if (Date.now() - (this.inflight.get(first.id) ?? 0) < 5000) return;
    this.inflight.set(first.id, Date.now());
    this.socket.send(
      JSON.stringify({
        type: "update",
        op_id: first.id,
        update: toBase64(first.update),
      }),
    );
  }
  stop() {
    return (this.stopWork ??= this.shutdown());
  }
  private async shutdown() {
    this.stopped = true;
    window.removeEventListener("offline", this.offline);
    window.removeEventListener("online", this.online);
    this.opening?.abort();
    clearTimeout(this.handshake);
    clearTimeout(this.retry);
    clearTimeout(this.flushTimer);
    clearInterval(this.heartbeat);
    this.socket?.close();
    await this.work;
    this.doc.getText("body").unobserve(this.onChange);
    this.doc.destroy();
    await this.cache.close();
  }
}
