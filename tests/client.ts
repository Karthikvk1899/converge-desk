import WebSocket from "ws";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import type { ServerMessage } from "../shared/protocol.ts";
export const API_A = process.env.API_A ?? "http://localhost:8081";
export const API_B = process.env.API_B ?? "http://localhost:8082";
export const ORIGIN = process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
export async function request(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
  base = API_A,
) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}
export async function principal(tenant: string, name: string, role = "editor") {
  const response = await request(
    "/admin/principals",
    process.env.ADMIN_KEY ?? "",
    "POST",
    { tenant, name, role },
  );
  if (response.status !== 201)
    throw new Error("Provisioning failed: " + response.status);
  return response.json() as Promise<{ id: string; token: string }>;
}
export async function create(token: string, title = "Runbook", body = "") {
  const r = await request("/api/documents", token, "POST", { title, body });
  if (r.status !== 201) throw new Error("Create failed " + r.status);
  return r.json() as Promise<{ id: string }>;
}
export async function until<T>(
  fn: () => T | undefined | false,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Timed out waiting for condition");
}
export class Peer {
  doc = new Y.Doc();
  events: ServerMessage[] = [];
  socket: WebSocket;
  closed = false;
  constructor(url: string, origin = ORIGIN) {
    this.socket = new WebSocket(url, { origin });
    this.socket.on("message", (raw) => {
      if (this.closed) return;
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.events.push(message);
      if (message.type === "hello")
        Y.applyUpdate(this.doc, Buffer.from(message.state, "base64"));
      if (message.type === "patch")
        Y.applyUpdate(this.doc, Buffer.from(message.update, "base64"));
    });
    this.socket.on("close", () => {
      this.closed = true;
    });
    this.socket.on("error", () => {
      this.closed = true;
    });
  }
  static async connect(token: string, id: string, base = API_A) {
    const r = await request(
      `/api/documents/${id}/tickets`,
      token,
      "POST",
      undefined,
      base,
    );
    if (r.status !== 200) throw new Error("Ticket failed " + r.status);
    const { ticket } = await r.json();
    const p = new Peer(base.replace(/^http/, "ws") + "/ws?ticket=" + ticket);
    await until(() => p.events.find((x) => x.type === "hello"));
    return p;
  }
  edit(value: string) {
    const chunks: Uint8Array[] = [];
    const listener = (u: Uint8Array) => chunks.push(u);
    this.doc.on("update", listener);
    this.doc.getText("body").insert(this.doc.getText("body").length, value);
    this.doc.off("update", listener);
    return Y.mergeUpdates(chunks);
  }
  send(update: Uint8Array, op_id = randomUUID()) {
    this.socket.send(
      JSON.stringify({
        type: "update",
        op_id,
        update: Buffer.from(update).toString("base64"),
      }),
    );
    return op_id;
  }
  async ack(id: string) {
    return until(() =>
      this.events.find(
        (e): e is Extract<ServerMessage, { type: "ack" }> =>
          e.type === "ack" && e.op_id === id,
      ),
    );
  }
  text() {
    return this.doc.getText("body").toString();
  }
  close() {
    this.closed = true;
    this.socket.close();
    this.doc.destroy();
  }
}
export function deniedSocket(url: string, origin = ORIGIN): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("handshake timeout"));
    }, 5000);
    ws.on("unexpected-response", (_req, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode!);
    });
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("unexpected accepted handshake"));
    });
    ws.on("error", () => {});
  });
}
