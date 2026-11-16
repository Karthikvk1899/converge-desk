CREATE TABLE IF NOT EXISTS schema_version(version int PRIMARY KEY CHECK(version=1));
INSERT INTO schema_version VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS principals(
 id uuid PRIMARY KEY,tenant text NOT NULL,name text NOT NULL,role text NOT NULL CHECK(role IN ('editor','viewer')),
 token_hash text UNIQUE NOT NULL,revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS documents(
 id uuid PRIMARY KEY,tenant text NOT NULL,title text NOT NULL,state bytea NOT NULL,seq bigint NOT NULL DEFAULT 0,
 content text NOT NULL DEFAULT '',author uuid NOT NULL REFERENCES principals(id),
 search tsvector GENERATED ALWAYS AS(to_tsvector('simple',title || ' ' || content)) STORED,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_scope ON documents(tenant,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS document_search ON documents USING gin(search);
CREATE TABLE IF NOT EXISTS updates(
 document_id uuid NOT NULL REFERENCES documents(id),op_id uuid NOT NULL,seq bigint NOT NULL,
 actor uuid NOT NULL REFERENCES principals(id),digest text NOT NULL,payload bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(document_id,op_id),UNIQUE(document_id,seq)
);
CREATE TABLE IF NOT EXISTS checkpoints(
 id uuid PRIMARY KEY,document_id uuid NOT NULL REFERENCES documents(id),tenant text NOT NULL,label text NOT NULL,
 seq bigint NOT NULL,content text NOT NULL,actor uuid NOT NULL REFERENCES principals(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkpoint_scope ON checkpoints(document_id,created_at DESC);
