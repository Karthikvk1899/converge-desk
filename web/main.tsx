import { useState, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
const Markdown = lazy(() => import("react-markdown"));
import type { Principal } from "../shared/protocol.ts";
import { Sync, type SyncState } from "./sync.ts";
import { LocalCache } from "./cache.ts";
const Editor = lazy(() =>
  import("./Editor.tsx").then((m) => ({ default: m.Editor })),
);
import "./style.css";
type Document = {
  id: string;
  title: string;
  seq: number;
  updated_at: string;
  characters: number;
};
type Checkpoint = {
  id: string;
  label: string;
  seq: number;
  actor: string;
  created_at: string;
};
type History = {
  seq: number;
  op_id: string;
  actor: string;
  created_at: string;
  digest: string;
};
export function App() {
  const [token, setToken] = useState(""),
    [actor, setActor] = useState<Principal | null>(null),
    [docs, setDocs] = useState<Document[]>([]),
    [current, setCurrent] = useState<Document | null>(null),
    [search, setSearch] = useState("");
  const [title, setTitle] = useState(""),
    [sync, setSync] = useState<Sync | null>(null),
    [status, setStatus] = useState<SyncState | null>(null),
    [body, setBody] = useState(""),
    [preview, setPreview] = useState(false),
    [label, setLabel] = useState(""),
    [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]),
    [history, setHistory] = useState<History[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function api(path: string, method = "GET", payload?: unknown) {
    const response = await fetch("/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      const result = await response
        .json()
        .catch(() => ({ error: "Request unavailable" }));
      throw new Error(result.error ?? "Request failed");
    }
    return response.json();
  }
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to complete request");
    } finally {
      setBusy(false);
    }
  }
  async function list(q = search) {
    setDocs(await api("/documents?q=" + encodeURIComponent(q)));
  }
  async function activity(document = current) {
    if (!document) return;
    const [c, h] = await Promise.all([
      api(`/documents/${document.id}/checkpoints`),
      api(`/documents/${document.id}/history`),
    ]);
    setCheckpoints(c);
    setHistory(h);
  }
  useEffect(() => {
    if (!current || !actor) return;
    let closed = false;
    const provider = new Sync(actor, current.id, token, (s) => {
      if (!closed) {
        setStatus(s);
        const content = provider.doc.getText("body").toString();
        setBody(content);
        setDocs((previous) =>
          previous.map((document) =>
            document.id === current.id
              ? { ...document, characters: content.length, seq: s.seq }
              : document,
          ),
        );
      }
    });
    void provider
      .start()
      .then(() => {
        if (!closed) setSync(provider);
      })
      .catch(() => {
        if (!closed)
          setError(
            "Unable to open browser storage. Use a supported browser with IndexedDB enabled.",
          );
      });
    return () => {
      closed = true;
      setSync(null);
      setStatus(null);
      void provider.stop();
    };
  }, [current?.id, actor?.id]);
  async function open(document: Document) {
    setCurrent(document);
    setPreview(false);
    setBody("");
    await activity(document);
  }
  function download() {
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      (current?.title ?? "document").replace(/[^a-zA-Z0-9_-]/g, "_") + ".md";
    link.click();
    URL.revokeObjectURL(url);
  }
  const canWrite = actor?.role === "editor";
  return (
    <div className="workspace">
      <aside>
        <a href="#" className="brand">
          <span className="logo">
            c<span>↗</span>
          </span>
          <span>
            converge<span className="brand-small">DESK</span>
          </span>
        </a>
        <div className="side-caption">TEAM NOTEBOOK</div>
        <div className="side-selected">
          ▤ &nbsp; Documents <span>{docs.length}</span>
        </div>
        <div className="side-copy">
          A shared place for the work
          <br />
          between deployments.
        </div>
        {actor && (
          <div className="identity">
            <span className="avatar">{actor.name[0]}</span>
            <div>
              <strong>{actor.name}</strong>
              <small>
                {actor.tenant} / {actor.role}
              </small>
            </div>
          </div>
        )}
        <div className="side-bottom">
          <span className="small-dot" /> Built for reconnection
          <p>
            Local edits. Shared context.
            <br />A durable record.
          </p>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <div className="eyebrow">ENGINEERING WORKSPACE</div>
            <h1>Good work comes together.</h1>
            <p>
              Write together, keep your context, and pick up where you left off.
            </p>
          </div>
          <span className="version">REFERENCE BUILD / 01</span>
        </header>
        {!actor ? (
          <section className="welcome">
            <div>
              <span className="eyebrow">ONE DOCUMENT. MANY PERSPECTIVES.</span>
              <h2>
                Stay on the same page.
                <br />
                Even when the network doesn’t.
              </h2>
              <p>
                A collaborative notebook for runbooks, design notes, and
                incident handoffs. Concurrent edits merge when your connection
                returns.
              </p>
              <div className="benefits">
                <span>↔ Concurrent editing</span>
                <span>◷ Local retry queue</span>
                <span>▣ Saved checkpoints</span>
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const me = await api("/me");
                  setDocs(await api("/documents"));
                  setActor(me);
                });
              }}
            >
              <h3>Open your workspace</h3>
              <label>
                Access credential
                <input
                  aria-label="Access credential"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste your scoped credential"
                />
              </label>
              <button disabled={!token || busy}>
                Connect to workspace <span>↗</span>
              </button>
              <small>
                Credentials stay in memory. Document contents and unacknowledged
                edits are stored on this browser, scoped to your identity.
              </small>
            </form>
          </section>
        ) : (
          <>
            <section className="topbar">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => list());
                }}
              >
                <input
                  aria-label="Search documents"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search title or document content…"
                />
                <button className="secondary" disabled={busy}>
                  Search
                </button>
              </form>
              <button
                className="plain"
                onClick={() => {
                  setCurrent(null);
                  setActor(null);
                  setToken("");
                  setDocs([]);
                  setCheckpoints([]);
                  setHistory([]);
                  setBody("");
                }}
              >
                Disconnect
              </button>
            </section>
            <div className="desk">
              <section className="library">
                <div className="section-heading">
                  <h2>Documents</h2>
                  <span>{docs.length.toString().padStart(2, "0")}</span>
                </div>
                {canWrite && (
                  <form
                    className="create"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        const created = await api("/documents", "POST", {
                          title,
                          body: "",
                        });
                        setTitle("");
                        await list("");
                        await open({
                          ...created,
                          characters: 0,
                          updated_at: new Date().toISOString(),
                        });
                      });
                    }}
                  >
                    <label>
                      New document
                      <input
                        aria-label="New document title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        maxLength={120}
                        placeholder="Name your next idea"
                      />
                    </label>
                    <button disabled={busy || !title.trim()}>
                      + Create document
                    </button>
                  </form>
                )}
                {!docs.length && (
                  <p className="empty">
                    No documents yet.
                    <br />
                    Start with a runbook or design note.
                  </p>
                )}
                {docs.map((d) => (
                  <button
                    key={d.id}
                    className={
                      "doc-card " + (current?.id === d.id ? "selected" : "")
                    }
                    onClick={() => run(() => open(d))}
                  >
                    <span className="doc-icon">▤</span>
                    <div>
                      <strong>{d.title}</strong>
                      <small>
                        {new Date(d.updated_at).toLocaleDateString()} ·{" "}
                        {d.characters} characters
                      </small>
                    </div>
                    <span>↗</span>
                  </button>
                ))}
              </section>
              <section className="document">
                {!current ? (
                  <div className="blank">
                    <span className="blank-mark">↗</span>
                    <h2>Make room for the next idea.</h2>
                    <p>
                      Open a document to edit together, or create a new one.
                    </p>
                    <div className="blank-grid">
                      <div>
                        <b>01</b>
                        <h3>Write naturally</h3>
                        <p>Markdown with local undo and a readable preview.</p>
                      </div>
                      <div>
                        <b>02</b>
                        <h3>Reconnect confidently</h3>
                        <p>
                          Your pending edits are retried with stable operation
                          IDs.
                        </p>
                      </div>
                      <div>
                        <b>03</b>
                        <h3>Keep a checkpoint</h3>
                        <p>
                          Capture a known state and fork it into a new document.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="document-head">
                      <div>
                        <span className="eyebrow">SHARED DOCUMENT</span>
                        <h2>{current.title}</h2>
                      </div>
                      <button
                        className="secondary"
                        onClick={download}
                        disabled={!sync}
                      >
                        Export .md
                      </button>
                    </div>
                    <div className="syncbar">
                      <span
                        className={
                          "connection " + (status?.status ?? "connecting")
                        }
                      >
                        <i />
                        {status?.status ?? "connecting"}
                      </span>
                      <span data-testid="pending">
                        {status?.pending ?? 0} pending
                      </span>
                      <span>revision {status?.seq ?? 0}</span>
                      <span className="saved">
                        {status?.durable
                          ? "Saved on this device"
                          : "Saving locally…"}
                      </span>
                    </div>
                    <div className="document-tools">
                      <div>
                        <button
                          className={!preview ? "tab active" : "tab"}
                          onClick={() => setPreview(false)}
                        >
                          Write
                        </button>
                        <button
                          className={preview ? "tab active" : "tab"}
                          onClick={() => setPreview(true)}
                        >
                          Preview
                        </button>
                      </div>
                      <div
                        className="presence"
                        aria-label="Active collaborators"
                      >
                        {status?.actors.map((p) => (
                          <span title={p.name} key={p.id}>
                            {p.name[0]}
                          </span>
                        ))}
                        <small>{status?.actors.length ?? 0} connected</small>
                      </div>
                    </div>
                    {status?.error && (
                      <div role="alert" className="alert">
                        {status.error} Your local document can be exported.
                      </div>
                    )}
                    {sync ? (
                      <div className="writing-surface">
                        <Suspense
                          fallback={
                            <div className="empty">Loading editor…</div>
                          }
                        >
                          <div hidden={preview}>
                            <Editor
                              doc={sync.doc}
                              readOnly={
                                !canWrite ||
                                status?.status === "blocked" ||
                                (status?.pending ?? 0) > 200
                              }
                            />
                          </div>
                          {preview && (
                            <article className="markdown">
                              <Markdown skipHtml>
                                {body ||
                                  "*Nothing here yet. Start writing in the editor.*"}
                              </Markdown>
                            </article>
                          )}
                        </Suspense>
                      </div>
                    ) : (
                      <div className="empty">Opening local document…</div>
                    )}
                    <div className="doc-footer">
                      <span>
                        {body.length.toLocaleString()} characters · Markdown
                      </span>
                      <span>
                        {canWrite ? "Editor access" : "Read-only access"}
                        {status?.instance ? " · " + status.instance : ""}
                      </span>
                    </div>
                    <div className="retention-note">
                      This browser keeps a local copy after disconnect.{" "}
                      <button
                        className="text-button"
                        disabled={
                          !sync ||
                          !status?.durable ||
                          (status?.pending ?? 0) > 0
                        }
                        onClick={() =>
                          run(async () => {
                            if (!sync) return;
                            const scope = sync.scope;
                            setCurrent(null);
                            await sync.stop();
                            const cache = new LocalCache();
                            try {
                              if ((await cache.pending(scope)).length)
                                throw new Error(
                                  "Pending edits were preserved; reopen the document to synchronize them.",
                                );
                              await cache.clear(scope);
                            } finally {
                              await cache.close();
                            }
                            setNotice(
                              "Local copy cleared. The server document is unchanged.",
                            );
                          })
                        }
                      >
                        Clear local copy
                      </button>
                    </div>
                    <section className="activity">
                      <div className="section-heading">
                        <h3>Checkpoints & activity</h3>
                        <button
                          className="plain"
                          disabled={busy}
                          onClick={() => run(() => activity())}
                        >
                          Refresh history
                        </button>
                      </div>
                      {canWrite && (
                        <form
                          className="checkpoint-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                              await api(
                                `/documents/${current.id}/checkpoints`,
                                "POST",
                                { label, expected_seq: status?.seq ?? 0 },
                              );
                              setLabel("");
                              await activity();
                              setNotice(
                                "Checkpoint saved from committed server state.",
                              );
                            });
                          }}
                        >
                          <input
                            aria-label="Checkpoint label"
                            placeholder="e.g. Reviewed incident handoff"
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            maxLength={120}
                          />
                          <button
                            disabled={
                              !label.trim() ||
                              busy ||
                              status?.status !== "online" ||
                              (status?.pending ?? 0) > 0
                            }
                          >
                            Save checkpoint
                          </button>
                        </form>
                      )}
                      {checkpoints.map((c) => (
                        <div className="checkpoint" key={c.id}>
                          <span>▣</span>
                          <div>
                            <strong>{c.label}</strong>
                            <small>
                              Revision {c.seq} · {c.actor}
                            </small>
                          </div>
                          {canWrite && (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  const created = await api(
                                    `/checkpoints/${c.id}/fork`,
                                    "POST",
                                    {
                                      title: ("Fork · " + c.label).slice(
                                        0,
                                        120,
                                      ),
                                    },
                                  );
                                  await list("");
                                  await open({
                                    ...created,
                                    updated_at: new Date().toISOString(),
                                    characters: 0,
                                  });
                                  setNotice(
                                    "Opened an independent document from the checkpoint.",
                                  );
                                })
                              }
                            >
                              Fork checkpoint
                            </button>
                          )}
                        </div>
                      ))}
                      <div className="history">
                        {history.slice(0, 8).map((h) => (
                          <div key={h.op_id}>
                            <span className="small-dot" />
                            <span>{h.actor} committed an edit</span>
                            <code>r{h.seq}</code>
                            <time>
                              {new Date(h.created_at).toLocaleTimeString()}
                            </time>
                          </div>
                        ))}
                        {!history.length && (
                          <p>
                            No committed edits yet. Local changes appear here
                            after acknowledgment and refresh.
                          </p>
                        )}
                      </div>
                    </section>
                  </>
                )}
              </section>
            </div>
          </>
        )}
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        <footer>
          CONVERGE DESK{" "}
          <span>
            Reference implementation · no production availability guarantee
          </span>
        </footer>
      </main>
    </div>
  );
}
if (document.getElementById("root"))
  createRoot(document.getElementById("root")!).render(<App />);
