import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import {
  yCollab,
  yUndoManagerKeymap,
  ySyncAnnotation,
} from "y-codemirror.next";
export function Editor({ doc, readOnly }: { doc: Y.Doc; readOnly: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const mode = useRef(new Compartment());
  useEffect(() => {
    const text = doc.getText("body");
    const undo = new Y.UndoManager(text);
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          Prec.highest(keymap.of(yUndoManagerKeymap)),
          yCollab(text, null, { undoManager: undo }),
          mode.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({
            "aria-label": "Document editor",
            role: "textbox",
            "aria-multiline": "true",
          }),
          EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || tr.annotation(ySyncAnnotation)) return tr;
            if (tr.newDoc.length > 100000) return [];
            let tooLarge = false;
            tr.changes.iterChanges((_a, _b, _c, _d, inserted) => {
              if (inserted.length > 4000) tooLarge = true;
            });
            return tooLarge ? [] : tr;
          }),
        ],
      }),
    });
    return () => {
      view.current?.destroy();
      undo.destroy();
    };
  }, [doc]);
  useEffect(() => {
    view.current?.dispatch({
      effects: mode.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);
  return <div className="editor-host" ref={host} />;
}
