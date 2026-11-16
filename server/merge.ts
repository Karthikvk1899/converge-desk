import * as Y from "yjs";
import { MAX_STATE, MAX_TEXT, MAX_UPDATE } from "../shared/protocol.ts";
export function merge(base: Uint8Array, update: Uint8Array) {
  if (update.byteLength > MAX_UPDATE) throw new Error("update exceeds 32 KiB");
  const doc = new Y.Doc();
  try {
    const text = doc.getText("body");
    if (base.byteLength) Y.applyUpdate(doc, base);
    Y.applyUpdate(doc, update);
    if ([...doc.share.keys()].some((k) => k !== "body"))
      throw new Error("only body text is supported");
    if (
      Object.keys(text.getAttributes()).length ||
      text
        .toDelta()
        .some(
          (d: { insert: unknown; attributes?: Record<string, unknown> }) =>
            typeof d.insert !== "string" ||
            Object.keys(d.attributes ?? {}).length,
        )
    )
      throw new Error("plain text only");
    const body = text.toString();
    const state = Y.encodeStateAsUpdate(doc);
    if (body.length > MAX_TEXT || state.byteLength > MAX_STATE)
      throw new Error("document capacity reached");
    return { state, body };
  } finally {
    doc.destroy();
  }
}
export function initial(body: string) {
  const doc = new Y.Doc();
  try {
    doc.getText("body").insert(0, body);
    const state = Y.encodeStateAsUpdate(doc);
    if (state.length > MAX_STATE) throw new Error("document capacity reached");
    return state;
  } finally {
    doc.destroy();
  }
}
