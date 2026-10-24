# Common Table POS prototype

A first vertical slice for a café/QSR counter: touch-first order entry, dine-in tables, takeaway, item modifiers, kitchen display, demo tender capture, offline order outbox, and an 80 mm ESC/POS mock printer.

## Requirements

- Node.js 22 or newer and npm 10 or newer
- For tablets on a local network, serve the production app over HTTPS. Browsers require a secure context for service workers outside `localhost`; development on the same machine can use `localhost`.

## Start in development

```sh
npm install
npm run dev
```

Vite serves the web client on port 5173 and proxies API/WebSocket traffic to the edge server on port 3001. From the server workspace, the edge server creates `apps/server/.data/common-table.db` in SQLite WAL mode and starts its mock ESC/POS TCP listener on `127.0.0.1:9100`.

## Build and run as one edge process

```sh
npm run build
npm start
```

When `apps/web/dist` exists, Express serves the client and API on port 3001. Set `PORT`, `POS_DATABASE_PATH`, `MOCK_PRINTER_HOST`, `MOCK_PRINTER_PORT`, or `DEMO_TAX_RATE_BPS` to configure the local process. Relative `POS_DATABASE_PATH` values resolve from `apps/server`. The default tax rate is a demo value, not a tax configuration for a real outlet.

## Vercel preview

The root `vercel.json` builds the monorepo and publishes `apps/web/dist` as a frontend preview. It does not deploy the local Express edge server: Vercel does not provide this prototype's durable SQLite WAL database or raw TCP printer socket. On the hosted preview, orders fall back to the current browser's IndexedDB outbox and are not shared with the local edge server or other devices. Payments and live KDS synchronization require the edge API. Use `npm run dev` or `npm run build && npm start` for the complete local prototype; use Vercel as a UI preview until a cloud API and database are implemented.

## Prototype boundaries

- The sample outlet, menu, staff, and tax are demo seed data. Tenant/outlet IDs and authorization are hardcoded; production requires authentication, role permissions, device enrollment, outlet configuration, backups, monitoring, and data-retention policy.
- Demo cash/UPI/card tenders are records only. No payment provider is called.
- Orders made while disconnected are stored in the browser's IndexedDB outbox and retried with the same command ID, preventing duplicate orders on server retries. Browser offline storage is per device/browser profile. Use the app once while connected before relying on the cached shell; across devices on a LAN, deploy with HTTPS.
- SQLite is the outlet edge database. `db/migrations/0001_core.sql` is the initial PostgreSQL cloud schema direction; cloud replication and conflict resolution are not wired into this prototype.
- The printer formats ESC/POS-compatible KOTs and receipts and sends them to a mock TCP socket. Validate byte width and printer-specific command support against the chosen hardware before connecting a real printer.

## Main routes

- `GET /api/health`, `/api/menu`, `/api/orders`, `/api/kitchen`
- `POST /api/orders`, `PATCH /api/orders/:orderId/status`
- `POST /api/orders/:orderId/payment`, `/api/printer/test`
- WebSocket `/socket` provides an initial kitchen snapshot and order updates
