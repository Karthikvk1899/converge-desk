import { z } from "zod";
export const MAX_UPDATE = 32768;
export const MAX_STATE = 524288;
export const MAX_TEXT = 100000;
export const names = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
export const plainText = z
  .string()
  .regex(/^[^\u0000]*$/, "NUL characters are not supported");
export const title = plainText.trim().min(1).max(120);
export const writeMessage = z
  .object({
    type: z.literal("update"),
    op_id: z.uuid(),
    update: z.string().max(44000),
  })
  .strict();
export const newPrincipal = z
  .object({
    tenant: names,
    name: plainText.trim().min(1).max(60),
    role: z.enum(["editor", "viewer"]),
  })
  .strict();
export const newDocument = z
  .object({ title, body: plainText.max(MAX_TEXT).default("") })
  .strict();
export const newCheckpoint = z
  .object({
    label: title,
    expected_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type Principal = {
  id: string;
  tenant: string;
  name: string;
  role: "editor" | "viewer";
};
export type ServerMessage =
  | {
      type: "hello";
      version: 1;
      seq: number;
      state: string;
      role: "editor" | "viewer";
      instance: string;
    }
  | { type: "patch"; seq: number; update: string; op_id: string; actor: string }
  | { type: "ack"; seq: number; op_id: string; duplicate: boolean }
  | { type: "presence"; actors: { id: string; name: string }[] }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      op_id?: string;
    };
export function toBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
