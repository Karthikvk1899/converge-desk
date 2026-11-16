# Hardening review

This review targets browser recovery and authorization test coverage. It is not an external security assessment or a production qualification.

## Corrected behaviors

- Terminal operation rejection remains blocked through offline/online transitions. Reconnecting must not silently bypass a rejection while retaining the rejected operation.
- Repeated connection requests cannot create a second live socket. Ticket requests and the initial WebSocket snapshot have deadlines; local editing does not wait for a ticket request to finish.
- A failed IndexedDB save blocks transmission and keeps the warning visible through subsequent saves. A later successful write does not prove the failed operation was safely queued.
- Closing a provider is idempotent. Clearing a local copy first stops its writer and drains queued work, then rechecks for pending operations before removing the cache. Other open tabs can still repopulate shared browser storage.
- Collaborative undo bindings take precedence over the editor's generic history shortcuts. Document-list character counts track the open document.

## Regression evidence

Three new state-machine tests were executed against the original published `cc3ae183c3bb2a13010272bf1bba9355d09e11a9` implementation and failed as expected: preserving blocked state, preventing duplicate connections, and retaining a storage-failure block. They pass with the fixes.

Additional tests exercise stalled ticket requests, missing initial snapshots, idempotent cleanup, cross-tenant history/checkpoints, viewer checkpoint/fork denial, large remote edits, collaborative undo, and raw-HTML preview suppression.

Local unit tests, TypeScript, formatting, and production builds can validate only part of this change. The added service/browser cases require the Docker and Chromium CI jobs. Until this revision has a passing GitHub Actions run, the earlier published CI result does not verify it.

## Remaining deployment work

No claim is made about AWS deployment, database HA, backup restoration, capacity under sustained load, TLS configuration, SSO integration, comprehensive accessibility conformance, container-image vulnerability status, or a live external security review. Opaque bearer credentials still lack automatic expiry and tenant roles are not document ACLs. Document and history growth remains bounded by explicit limits rather than retention/compaction. The editor bundle still exceeds Vite's default 500 kB chunk warning threshold; it is lazy loaded, and no measured frontend performance budget has been qualified.
