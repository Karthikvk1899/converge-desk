# Operations runbook

## Start and inspect

Use README quickstart. `docker compose ps` reports dependency health. `curl http://localhost:8081/health/ready` checks PostgreSQL schema and Redis; `/health/live` only checks the API process. Both API replicas use the same database. Nginx sends connections to either replica; it is not required that HTTP and WebSocket reach the same replica.

Request logging is disabled to avoid bearer/ticket/document leakage; Nginx access logs are disabled. Container startup errors and process failures are still available through `docker compose logs`. The document history exposes ordered operation IDs, actors, timestamps and digests, not document payloads. This version does not export Prometheus metrics; production alerting/telemetry integration remains work.

Suggested operational signals: readiness failure, database connection/lock pressure, row/log growth, WebSocket reconnect frequency, client pending count, worker rejection frequency, disk/WAL saturation. Avoid document/principal IDs as unbounded metric labels. Never enable raw URL or payload logging without redaction.

## Failure matrix

| Symptom | Expected behavior | Operator action |
| --- | --- | --- |
| Redis stopped | Existing sockets write/poll PostgreSQL; presence disappears; new tickets fail503 | Restore Redis; clients obtain fresh tickets |
| API stopped | Its sockets disconnect; persisted pending edits retry through another instance | Restore API; inspect restart cause |
| PostgreSQL stopped | No new durable acknowledgments; operations remain pending; readiness fails | Restore DB, check storage, then let stable-ID retries resolve |
| Lost ack | Same operation UUID is retried; original sequence returned | No manual replay or new UUID required |
| Credential revoked | Writes fail; existing sessions close on write/poll | Provision authorized replacement; cached files are not remotely erased |
| State cap reached | Update rejected; local content retained/blocked | Export content; fork last checkpoint into fresh document |
| Local persistence failed | UI warns edit may not survive closing | Export Markdown immediately; resolve browser storage availability |

Run `node scripts/faults.ts` only on the disposable Compose demo. It stops services and restarts them in a finally block. CI checks Redis outage, lost-ack replay through another API, and database outage with no false acknowledgment. These tests are not chaos qualification under sustained load or database failover.

## Backup and restore

The `data` volume holds the authoritative database; Redis is not backed up. A snapshot must include principals, documents, updates, checkpoints, and schema version together. For an offline exercise, stop writes, then use PostgreSQL's supported `pg_dump`/`pg_restore` tooling and verify row counts, document contents, checkpoint forks, and deduplication behavior in a separate stack. Do not restore a subset of update records independently of snapshots.

A backup older than an acknowledged edit can lose that edit. Browser caches are not a backup: after acknowledgments, outbox items are removed. RPO/RTO, point-in-time recovery, encryption, retention, and restoration testing must be established before a deployment handles valuable data. The `node scripts/backup-restore.ts` CI rehearsal restores a logical dump into a uniquely named disposable database. It checks a fixture’s credential hash, checkpoint, CRDT snapshot, sequence, duplicate retry, and subsequent editing; it also verifies the source document remains unchanged. The temporary database is removed in a finally block. This does not establish production RPO/RTO, PITR, physical restore, encrypted-backup recovery, or large-dataset behavior.

## Configuration and deployment boundary

`ADMIN_KEY` must have at least32 characters; the initialization script generates a random secret with0600 file mode. `DATABASE_URL`, `REDIS_URL`, `PUBLIC_ORIGIN`, `PORT`, and `INSTANCE_ID` configure the server. Migrations run explicitly before APIs start and serialize through a PostgreSQL advisory lock.

Compose binds exposed ports to127.0.0.1. Its known development database password and HTTP transport are for a local machine only. For an external deployment, provide TLS, replace all secrets, restrict admin/API ports, set exact `PUBLIC_ORIGIN`, update Nginx `connect-src` to the intended HTTPS/WSS origin, configure trusted proxy/rate-limit behavior, private database networking, resource limits, encrypted volumes/backups, and independent monitoring.

Dependency versions are in `package-lock.json`. Actions are pinned to commit SHAs. Container base tags track supported lines rather than immutable image digests; evaluate/pin scanned digests as part of deployment release management. No AWS infrastructure is provisioned by this repository.

## Data lifecycle

No document delete API, edit-log compaction, retention scheduler, or credential expiry exists. Token hashes remain after revocation for history attribution. Checkpoints retain full plaintext. Capacity planning must include Yjs metadata and full snapshot rewrites per update, not just visible Markdown size. Search returns at most50 documents, ordered by modification time. Export important documents before clearing site storage. Disconnect removes in-memory credentials but deliberately retains recovery caches.
