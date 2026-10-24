# Common Table POS prototype

See [ROADMAP.md](ROADMAP.md) for the target architecture, delivery stages, and pilot acceptance checklist.

A first vertical slice for an Indian mithai-house/QSR counter: touch-first order entry, dine-in tables, takeaway, item modifiers, kitchen display, demo tender capture, offline order outbox, and an 80 mm ESC/POS mock printer. The fictional Indore Mithai House catalogue contains 43 vegetarian training items across breakfast, chaat, North Indian food, thalis, sweets, namkeen, cookies, and beverages.

The catalogue is inspired by publicly listed Apna Sweets offerings and categories. Names and prices in the prototype are illustrative, some prices are estimates, and this is not an Apna Sweets account or a verified copy of its current menu. Confirm actual item, portion, price, tax, and outlet details before using it commercially.

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

## Build and run as one edge process

```sh
npm run build
npm start
```

When `apps/web/dist` exists, Express serves the client and API on port 3001. Copy `.env.example` to `.env` and set the outlet's `POS_*` values before a production run. Demo identity defaults are allowed only in development; production requires explicit tenant, outlet, terminal, and actor configuration. The default tax rate is a demo value, not a tax configuration for a real outlet.

The server adds an `x-request-id` response header and emits one JSON request log per HTTP request. `GET /api/health` is the liveness endpoint; `GET /api/ready` checks required outlet configuration and SQLite integrity; `GET /api/context` returns the configured outlet identity needed by the POS UI. To create a SQLite-consistent backup while the edge server is running, build first and run `npm --workspace @common-table/server run backup`. Set `POS_BACKUP_PATH` to choose the destination. Verify that the backup log reports `integrity: "ok"`; store backups outside the outlet device and practice restoration before pilot use.

## Vercel deployment

The root `vercel.json` builds the monorepo and publishes `apps/web/dist`. It hosts the frontend and `/admin` manager onboarding route, but does not deploy the local Express edge server: Vercel does not provide this prototype's durable SQLite WAL database or raw TCP printer socket. The Supabase URL and publishable key are browser-safe and configured on the Vercel production environment only. Do not add a service-role/secret key to a `VITE_*` variable. Orders from the hosted frontend remain in that browser's IndexedDB outbox unless connected to the outlet edge; they are not cloud-synced or shared with other devices. Payments and live KDS synchronization require the edge API. Use `npm run dev` or `npm run build && npm start` for the complete local prototype.

## Prototype boundaries

- The menu, staff, and tax are demo data. Outlet identity is configurable through environment settings. The `/admin` manager route creates tenants/outlets, staff invitations, and cloud terminal records; local edge staff authentication, terminal-key pairing, managed menu administration, retention, and cloud order sync still need implementation. Staff invite links are returned for the manager to share manually; no staff invitation email is sent.
- Demo cash/UPI/card tenders are records only. No payment provider is called.
- Orders made while disconnected are stored in the browser's IndexedDB outbox and retried with the same command ID, preventing duplicate orders on server retries. Browser offline storage is per device/browser profile. Use the app once while connected before relying on the cached shell; across devices on a LAN, deploy with HTTPS.
- SQLite is the outlet edge database. `db/migrations/0001_core.sql` is the initial PostgreSQL cloud schema direction; cloud replication and conflict resolution are not wired into this prototype.
- The printer formats ESC/POS-compatible KOTs and receipts and sends them to a mock TCP socket. Validate byte width and printer-specific command support against the chosen hardware before connecting a real printer.

## Main routes

- `GET /api/health`, `/api/ready`, `/api/context`, `/api/menu`, `/api/orders`, `/api/kitchen`
- `POST /api/orders`, `PATCH /api/orders/:orderId/status`
- `POST /api/orders/:orderId/payment`, `/api/printer/test`
- WebSocket `/socket` provides an initial kitchen snapshot and order updates
