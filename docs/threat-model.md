# Threat model

## Assets and trust boundaries

Document text, CRDT metadata, checkpoints, actor identity, credentials, and pending browser edits are sensitive. The browser is untrusted. API instances, PostgreSQL and Redis are within the deployment trust boundary. Redis is trusted for ticket integrity but not durable edit delivery. Administrators can provision principals for any tenant and therefore read that tenant's documents.

## Controls and residual risks

| Threat | Implemented control | Residual risk |
| --- | --- | --- |
| Cross-tenant document access | Server-derived tenant filter on every document operation; tests cover reads, tickets, history and checkpoints | Tenant-wide roles; no per-document ACL |
| Unauthorized writes | Editor role rechecked in transaction on every update/create/checkpoint/fork | Compromised editor can intentionally corrupt text or consume resources |
| Credential theft/replay | Random tokens stored as SHA256 hashes; memory-only browser credential; revocation | Bearer token grants access until revoked; no expiry/SSO/MFA |
| Cross-site WebSocket hijacking | Exact Origin check, one-use30-second tickets, atomic consumption, reauthorization | Non-browser clients can forge Origin; token remains the actual authorization boundary |
| Ticket leakage | Token-free ticket URL, disabled access/request logs, short TTL | Upstream proxy/observability configuration can reintroduce URL capture |
| Malicious Markdown | React escaping, raw HTML skipped, CSP forbids external images/scripts, no server URL fetching | Dependencies and same-origin script compromise still threaten data |
| Malformed CRDT/DoS | Strict envelope, size/root/type limits, worker deadline/heap cap, worker/socket/queue/backpressure limits | Not a proof against native allocation or distributed DoS; rate limits per process |
| SQL injection | Parameterized SQL and fixed query structure | Database credential compromise bypasses application checks |
| Duplicate delivery | Stable UUID + actor/digest match under row lock | New UUIDs can create extra no-op log entries; no tenant storage quota |
| Lost pub/sub | Database polling and full-snapshot reconnect | Polling introduces delay; no latency SLO |
| Local cache disclosure | Scoped cache keys, explicit clear action, disclosure, no token persistence | Same-profile users/XSS can read caches; revocation cannot erase offline copies |
| Supply chain | Lockfile, npm audit gate, CodeQL, SHA-pinned actions | No exhaustive review, SBOM attestation or container vulnerability gate |

## Rendering and identity details

Presence names are taken from server principal records and React-escaped; client update envelopes cannot impersonate actors. Presence is ephemeral and not used for access control. Renderer links use react-markdown's URL filtering; images are constrained by CSP. The server does not fetch user URLs, so it has no document-import SSRF path.

## Security testing boundaries

Tests exercise tenant isolation, read-only denial, revoked existing sessions, one-use ticket consumption, wrong Origin, malformed/rich/oversized Yjs payloads, duplicate conflicts, HTTP auth and browser storage behavior. They do not establish absence of all vulnerabilities. No penetration test, production identity-provider test, hostile-load test, external TLS deployment, or comprehensive image scan has been performed as part of the reference implementation.

Report potential vulnerabilities privately per SECURITY.md. Do not include real tenant data, credentials, or private incident notes in public issues.
