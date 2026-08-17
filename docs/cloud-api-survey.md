# Cloud API survey — blue.flopos.com

Status: **survey.** Read-only reconnaissance of the FloAdmin cloud that the
FloCafe edge talks to, as the first step of re-engineering the server side for
the restaurant-OS edge-sync work. No cloud code lives in this repo; the contract
below is reconstructed from the edge client (`main/services/cloud-sync.ts`) and a
live read-only probe on 2026-08-17.

## What it is

- Base URL: `https://blue.flopos.com/` (`DEFAULT_CLOUD_SERVER_URL`).
- **API-only, JSON.** `GET /` → 404, `GET /api/health` → 404. No web UI, no health route.
- Fronted by **Caddy** (`Via: 0.0 Caddy`, `Alt-Svc: h3`). HTTP/1.1 + HTTP/3.
- Hardened: `Content-Security-Policy: default-src 'none'`, `HSTS`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`.
- Backend language not exposed by headers; `cloud-v2-plan.md` refers to `pos.php`,
  so it is most likely **PHP**.

## Auth — HMAC request signing

Every endpoint except onboarding requires a signed request. Signing is in
`cloud-sync.ts` `buildSignedHeaders()`; the server advertises the header set via
CORS `Access-Control-Allow-Headers`.

```
Authorization:      Bearer <api_key>
X-Flo-POS-Hash:     <pos_hash>
X-Flo-Timestamp:    <ISO-8601>
X-Flo-Nonce:        <uuid>
X-Flo-Body-SHA256:  <sha256(body) hex>
X-Flo-Signature:    sha256=<HMAC-SHA256(api_key, signatureBase)>

signatureBase = METHOD \n path \n timestamp \n nonce \n sha256(body)
```

`X-Api-Key` also appears in the allowed headers (alternate key transport). The
same signing secures the WebSocket relay handshake. Full spec lives off-repo:
`floadmin.md § Identity & request signing` (private specs).

## Endpoints (from the edge client)

Onboarding is unauthenticated (creates the store, returns `store_id` + `api_key`);
everything else is signed.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/pos/register` | POS-hash only | Auto-register on first boot; returns `store_id`, `api_key` |
| POST | `/api/pos/heartbeat` | signed | Liveness + rollup (active orders, today sales) |
| POST | `/api/pos/events` | signed | **Store-and-forward event sink** (the sync channel) |
| POST | `/api/pos/pairing-code` | signed | Issue short-lived RevFlo pairing code |
| GET  | `/api/pos/devices` | signed | List paired devices |
| POST | `/api/pos/connection-test` | signed | Verify credentials/reachability |
| GET/PUT | `/api/pos/email-preferences` | signed | Notification prefs |
| POST | `/api/pos/email/verification` | signed | Email verification |
| POST | `/api/pos/diagnostics` · `/diagnostics-consent` | signed | Store-attributed diagnostics |
| POST | `/api/pos/support-ticket` | signed | Support outbox delivery |
| POST | `/api/pos/relay` | signed | WebSocket relay bootstrap |
| POST | `/api/pos/cloud-data/delete` · `/deletion-request/cancel` | signed | GDPR/DPDPA data deletion |

### Live probe (read-only)

```
GET  /                          → 404  (Caddy, JSON {"error":"Not found"})
GET  /api/health                → 404
POST /api/pos/connection-test   → 401  (needs signature)
POST /api/pos/register {}       → 400  (accepts POST, rejects empty body)
```

## The sync channel today: `/api/pos/events`

The edge outbox (`cloud_sync_outbox`) flushes here:

```json
POST /api/pos/events   (signed)
{ "pos_hash": "...", "events": [ { "event_type", "entity_type", "entity_id", "payload", "event_seq" } ], "sent_at": "..." }
```

Our restaurant-OS edge-sync (migration v71) already emits into this same outbox
with `event_seq` + an idempotency key in the payload, entity types `order` and
`table_session` (`session.opened` / `session.closed`). So **new edge events
already reach the cloud through the existing `/api/pos/events` sink** — no new
transport is required on the edge.

## Re-engineering entry points (server side)

What the cloud must gain to complete the restaurant-OS design (doc
`docs/restaurant-os/05-sync-protocol.md`), keyed off what already exists:

1. **`/api/pos/events` receiver** — accept and persist the new `table_session`
   entity + `session.*` event types. Dedupe on `(pos_hash, payload.idempotency_key)`.
   Apply in `event_seq` order per store (the cursor).
2. **`edge_sync_events`** table (accepted events, unique on `(store, idempotency_key)`).
3. **`edge_cursors`** — last applied `event_seq` per store; ignore ≤ cursor on replay.
4. **`edge_commands`** — cloud→edge queue, pulled on the edge's next signed poll
   (add a signed `GET /api/pos/commands`). Ack by `command_id`, idempotent apply.
5. **Conflict handling** — orders/sessions: edge wins; menu/price/config: cloud
   wins via commands; payments immutable on idempotency key.
6. **Observability** — per-store device status + queue depth (mirror the edge's
   `/api/edge-admin/status`).

The edge already carries `event_seq`, idempotency keys, and store-and-forward
retry, so most of the remaining work is **server-side only** and additive to the
existing `/api/pos/events` + `/api/pos/register` contract.
