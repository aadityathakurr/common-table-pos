# Common Table POS prototype

See [ROADMAP.md](ROADMAP.md) for the target architecture, delivery stages, and pilot acceptance checklist.

A first vertical slice for an Indian mithai-house/QSR counter: touch-first order entry, dine-in tables, takeaway, item modifiers, kitchen display, demo tender capture, offline order outbox, and an 80 mm ESC/POS mock printer. The fictional Indore Mithai House catalogue contains 43 vegetarian training items across breakfast, chaat, North Indian food, thalis, sweets, namkeen, cookies, and beverages.

The catalogue is inspired by publicly listed Apna Sweets offerings and categories. Names and prices in the prototype are illustrative, some prices are estimates, and this is not an Apna Sweets account or a verified copy of its current menu. Confirm actual item, portion, price, tax, and outlet details before using it commercially.

Reference sources: [Apna Sweets official website](https://www.apnasweets.com/) and [a public Indore menu listing](https://indiarestros.com/r/apna-sweets-indore-city-jhec8rx687), which reports a 375-item menu last updated 14 October 2026. The demo includes only a 43-item subset and does not reuse the listing's descriptions or images.

## Requirements

- Node.js 22 or newer and npm 10 or newer
- For tablets on a local network, serve the production app over HTTPS. Browsers require a secure context for service workers outside `localhost`; development on the same machine can use `localhost`.

## Start in development

```sh
npm install
cp .env.example .env # optional for the local demo; use POS_* values for a real outlet
npm run dev
```

Vite serves the web client on port 5173 and proxies API/WebSocket traffic to the edge server on port 3001. From the server workspace, the edge server creates `apps/server/.data/common-table.db` in SQLite WAL mode and starts its mock ESC/POS TCP listener on `127.0.0.1:9100`.

## Supabase schema and local Auth

The tracked `supabase/migrations` directory includes the migrations already applied to the dedicated `common-table-pos` project, followed by the cloud order, payment, shift, cash movement, and audit projections. The local Supabase Auth Site URL is `http://localhost:5173`, matching Vite; it is separate from the hosted project's Auth settings. For a local Supabase stack, install Docker and run `npx supabase start` followed by `npx supabase db reset`. The local stack is configured not to load sample business records by default.

For hosted sign-up links, configure Supabase **Authentication → URL Configuration** with Site URL `https://common-table-pos.vercel.app` and allow `https://common-table-pos.vercel.app/admin`. The Confirm signup email should link to `{{ .ConfirmationURL }}`, which carries the redirect requested by the manager app. If a custom template constructs a callback URL manually, use `{{ .RedirectTo }}` instead of `{{ .SiteURL }}` for its redirect target. Vercel preview deployments intentionally have no production Supabase credentials.

## Build and run as one edge process

```sh
npm run build
npm start
```

When `apps/web/dist` exists, Express serves the client and API on port 3001. Copy `.env.example` to `.env` and set the outlet's `POS_*` values before a production run. Production also requires a random `POS_SESSION_SECRET` of at least 32 characters and the Supabase project URL and publishable key. `POS_ACTOR_ID` remains a development fallback; order, void, payment, and shift audit records use the signed-in staff user's ID. The default tax rate is a demo value, not a tax configuration for a real outlet.

The server adds an `x-request-id` response header and emits one JSON request log per HTTP request. `GET /api/health` is the liveness endpoint; `GET /api/ready` checks required outlet configuration and SQLite integrity; `GET /api/context` returns the configured outlet identity needed by the POS UI. Protected API routes require a staff session. Sign in through `/admin` on the same outlet edge origin; Supabase verifies the user and outlet membership, then the edge sets a signed `HttpOnly` cookie that keeps working during a WAN outage. Owner/manager, cashier, kitchen, and viewer roles have separate route permissions. Kitchen API and WebSocket snapshots omit order and item prices. An owner or manager can download `GET /api/support/diagnostics.json` from the outlet edge for a support bundle containing database checks, order-state counts, sync queue health, printer mode, and runtime version. The export omits order/customer records, auth tokens, and database paths.

To create a SQLite-consistent backup while the edge server is running, build first and run `npm --workspace @common-table/server run backup`. Set `POS_BACKUP_PATH` to choose the destination. Verify that the backup log reports `integrity: "ok"`; store backups outside the outlet device. To restore, stop the edge service and run:

```sh
POS_RESTORE_SOURCE=/path/to/verified-backup.db \
POS_RESTORE_PATH=/path/to/common-table.db \
npm --workspace @common-table/server run restore
```

The restore command checks SQLite integrity, foreign keys, and the configured tenant/outlet before replacement. If the destination exists, it creates and verifies a `.pre-restore-<timestamp>.db` safety copy. Confirm `database.restore.completed` and `integrity: "ok"`, then start the edge and check `/api/ready` before allowing service.

## Vercel deployment

The root `vercel.json` builds the monorepo and publishes `apps/web/dist`. It hosts the frontend and `/admin` manager onboarding route, but does not deploy the local Express edge server: Vercel does not provide this prototype's durable SQLite WAL database or raw TCP printer socket. The Supabase URL and publishable key are browser-safe and configured on the Vercel production environment only. Do not add a service-role/secret key to a `VITE_*` variable. Orders from the hosted frontend remain in that browser's IndexedDB outbox unless connected to the outlet edge; they are not cloud-synced or shared with other devices. Payments and live KDS synchronization require the edge API. Use `npm run dev` or `npm run build && npm start` for the complete local prototype.

## Prototype boundaries

- The Indore menu and tax remain training data. Outlet identity is configurable through environment settings, and paired edges refresh outlet name, timezone, currency, tax, and menu together from Supabase; the last accepted snapshot is persisted in SQLite and orders retain their original currency and tax snapshot. The `/admin` route supports tenant/outlet setup, cloud menu administration, staff invitations, and terminal enrollment/revocation. Its one-time terminal configuration includes the browser-safe Supabase URL/key, outlet/terminal identifiers, a local session-signing secret, and the terminal sync key; keep the copied configuration in the outlet server's private `.env`. Once that edge starts, its terminal-authenticated menu pull confirms the key and updates the portal's `Last seen` status (refreshed every 15 seconds). Staff invite links are returned for the manager to share manually; no staff invitation email is sent. Local edge sessions and role-based API permissions are implemented and covered by the mock-auth integration test; a real second-user invite and an on-site terminal install still need pilot verification.
- Demo cash/UPI/card tenders are records only. No payment provider is called.
- Orders made while disconnected are stored in the browser's IndexedDB outbox and retried with the same command ID, preventing duplicate orders on server retries. Browser offline storage is per device/browser profile. Use the app once while connected before relying on the cached shell; across devices on a LAN, deploy with HTTPS.
- SQLite is the outlet edge database. A terminal-authenticated pull refreshes the managed outlet menu into SQLite as an atomic snapshot; menu versions use ETags, and order acceptance continues from the local copy during WAN loss. A durable local outbox syncs append-only business events to Supabase; a database trigger transactionally maintains tenant/outlet-scoped order, line, payment, shift, cash movement, and audit projections. The deployed `pos-reports` function reads those projections under the caller's manager RLS policy; its UI requires a deployed frontend and authenticated manager session. The edge's Daily reports page reads local SQLite for timezone-aware sales, tax, tender, item, void, and shift closeout totals and exports CSV; it is unavailable from the Vercel-only preview. Offline menu editing and merge-conflict resolution are not implemented.
- The printer formats 80 mm ESC/POS-compatible KOTs and receipts. Development defaults to a local mock TCP printer; production defaults to printing disabled. A configurable `network` mode sends raw TCP to a LAN printer (`POS_PRINTER_HOST`, `POS_PRINTER_PORT`, default 9100). This is a generic adapter, not a verified vendor driver: validate paper width, character encoding, cutter/drawer commands, and delivery behavior on the selected hardware before pilot use. The send callback only confirms the OS accepted the bytes, not that paper physically printed.

## Main routes

- Public: `GET /api/health`, `/api/ready`, `/api/context`. Staff session: `GET/POST/DELETE /api/auth/session`.
- Protected: `/api/menu`, `/api/orders`, `/api/kitchen`, `/api/sync/status`, and report routes; permissions vary by staff role.
- `GET /api/reports/daily`, `/api/reports/daily.csv` (outlet-local business date; local SQLite data)
- `POST /api/orders`, `POST /api/orders/:orderId/lines`, `POST /api/orders/:orderId/lines/:lineId/void`, `POST /api/orders/:orderId/void`
- `PATCH /api/orders/:orderId/status`, `/api/orders/:orderId/stations/:station/status`
- `POST /api/orders/:orderId/payment`, `/api/printer/test`
- WebSocket `/socket` provides an initial kitchen snapshot and order updates
