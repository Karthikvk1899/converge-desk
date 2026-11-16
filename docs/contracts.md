# Contracts

HTTP API version: 0.1.0. WebSocket hello protocol version: 1. Breaking wire changes require a version change. Runtime request schemas live in `shared/protocol.ts`; generated HTTP route/body schemas are in `openapi.json`. This file specifies response/event behavior not fully expressed by the generated schema.

## HTTP

All `/api` routes require `Authorization: Bearer <principal token>`. Admin routes require the separate `ADMIN_KEY` and are available on the loopback API ports, not the Nginx public route. Error responses are `{ "error": "description" }`; dependency failures use a generic 503 message. Responses use `Cache-Control: no-store`. UUID path parameters are validated.

| Method and path | Input | Success |
| --- | --- | --- |
| POST `/admin/principals` | `{tenant,name,role:"editor"|"viewer"}` | 201 `{id,token,tenant,name,role}`; token shown once |
| DELETE `/admin/principals/:id` | None | 204; future actions revoked |
| GET `/api/me` | None | `{id,tenant,name,role}` |
| POST `/api/documents` | `{title,body?}` | 201 `{id,title,seq}`; editor only |
| GET `/api/documents?q=words` | Search string, max120 | Array of up to50 `{id,title,seq,updated_at,characters}` |
| GET `/api/documents/:id` | None | `{id,title,seq,body,state,updated_at}`; state is base64 Yjs v1 update |
| POST `/api/documents/:id/tickets` | None | `{ticket,expires_in:30}` |
| GET `/api/documents/:id/history` | None | Last50 `{seq,op_id,digest,created_at,actor}` |
| POST `/api/documents/:id/checkpoints` | `{label,expected_seq}` | 201 `{id,label,seq}`; editor only,409 if stale |
| GET `/api/documents/:id/checkpoints` | None | Last50 `{id,label,seq,created_at,actor}` |
| POST `/api/checkpoints/:id/fork` | `{title}` | 201 new document; editor only |
| GET `/api/openapi.json` | None | Generated OpenAPI schema |
| GET `/health/live` | No auth | `{status:"up",instance}` |
| GET `/health/ready` | No auth | `{status:"ready"}` only if database schema and Redis available |

Search uses PostgreSQL `plainto_tsquery('simple', q)`: lexical token AND matching, no stemming or fuzzy matching. A missing document and another tenant's document both return404. Viewer writes return403. Invalid schema/UUID returns400 or422 depending on HTTP schema versus handler validation. An unknown/revoked credential returns401. Rate limits return429.

## WebSocket

Connect to `/ws?ticket=<ticket>` with the exact configured Origin. Tickets contain 256 random bits, expire after30 seconds, are consumed atomically once, and are reauthorized at handshake. They are stored hashed in Redis. A consumed ticket is not reusable even if authorization fails. Credentials never appear in the URL. Proxies must still suppress ticket query logging.

Server first sends:

```json
{"type":"hello","version":1,"seq":12,"state":"BASE64_YJS_V1_SNAPSHOT","role":"editor","instance":"replica-a"}
```

Client submits only this strict envelope (unknown fields rejected):

```json
{"type":"update","op_id":"fa16e746-b1ab-4b58-94c0-93425f6cc42e","update":"BASE64_YJS_V1_UPDATE"}
```

Server responses:

```json
{"type":"ack","op_id":"fa16e746-b1ab-4b58-94c0-93425f6cc42e","seq":13,"duplicate":false}
{"type":"patch","seq":13,"op_id":"fa16e746-b1ab-4b58-94c0-93425f6cc42e","update":"BASE64_YJS_V1_UPDATE","actor":"Alice"}
{"type":"presence","actors":[{"id":"8db87561-a538-4ef4-a7f8-96051b3c4afd","name":"Alice"}]}
{"type":"error","code":"503","message":"temporarily unavailable; edit retained locally","retryable":true,"op_id":"fa16e746-b1ab-4b58-94c0-93425f6cc42e"}
```

Ack and patch may arrive in either relative order. A patch is not a replacement for acknowledgment of the local operation. Patches are sent in sequence order per connection, including the sender's own updates. Reconnect sends a full snapshot; the browser applies it to cached CRDT state, then retries its persisted outbox. There is no cursor resume parameter.

Codes:409 conflicting op ID;422 invalid/bounded CRDT;401/403/404 lost access;503 temporary database/worker availability. Validation errors with no parseable operation ID may omit `op_id`. Access loss closes4403. Capacity/slow-consumer failures close1013. Invalid binary/oversized/budget-exceeding frames close1008. Standard ping/pong detects dead sockets.

## Resource bounds

32KiB decoded update,512KiB full CRDT state,100,000 visible text characters;64KiB HTTP/WebSocket transport envelope. At most100 live sockets and4 merge workers per API process,16 queued inbound messages per socket,30-message burst with10/second refill. Slow consumers exceeding1MiB buffered output reconnect. HTTP rate limiting is300 requests/minute per source IP per replica, not a distributed tenant quota. A proxy can aggregate clients into one IP.

The editor limits one inserted chunk to4,000 characters, protects the document cap, and becomes read-only above200 locally pending operations. These are usability protections, not trusted server validation. IndexedDB storage is not guaranteed. Presence expires after15 seconds without refresh and is not an authorization or durability signal.
