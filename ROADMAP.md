# Common Table POS: build roadmap

## Product target

Build a dependable POS for one Indian cafe/QSR pilot with dine-in and takeaway, used from tablets and laptops. Cashiers must be able to take orders during an internet outage, kitchens must see those orders on the outlet network, and records must sync to the cloud after reconnection.

## Deployment shape

- **Outlet edge (`apps/server`)**: always-on Node service at the restaurant; SQLite in WAL mode for local orders and configuration; owns local order numbering, outbox sync, KDS updates, and printer adapters. The mock TCP printer is for development only.
- **Web clients (`apps/web`)**: cashier POS, KDS, and later manager/admin screens. Vercel can host these and their cloud-facing APIs.
- **Cloud control plane**: managed PostgreSQL for accounts, tenant/outlet configuration, cloud copies of synced business records, backups, and management/reporting. Serverless APIs must use a supported pooled connection.
- **Sync**: local durable outbox, stable idempotency keys, versioned configuration, acknowledgements, retry/backoff, and an operator-visible conflict queue. Local order acceptance must not wait for cloud connectivity.

Vercel is a good home for the hosted web/control plane. The local edge process remains at each restaurant because it needs durable local writes and access to LAN printers. Do not deploy the outlet SQLite file or raw printer socket as a Vercel function.

## Roadmap

### 0. Pilot definition and architecture (in progress)

- Lock the first outlet type and devices: cafe/QSR, dine-in + takeaway, browser on tablets/laptops.
- Document offline-first boundary, data ownership, and rollout stages.
- Choose hosted Postgres/auth provider and payment terminal/provider before wiring credentials or real payments.

**Done when:** pilot scope and deployment boundaries are agreed; providers are selected before credentials or production data are introduced.

### 1. Production foundation

- Add real sign-in, tenant/outlet membership, role permissions, staff identities, and terminal enrollment. Remove hardcoded demo identity from request handling.
- Add migrations and configuration for both local SQLite and cloud Postgres; make tenant/outlet scoping mandatory in repository operations.
- Add outlet setup: timezone, currency, tax configuration, receipt identity, dining areas/tables, and kitchen stations.
- Add secrets handling, structured logs, request IDs, health/readiness checks, backup/restore notes, and development/staging/production environments.

**Done when:** a manager can create an outlet, invite staff with roles, enroll a terminal, and see only their authorized outlet data.

### 2. Reliable order and kitchen loop

- Manage menu categories, items, variants/modifiers, availability, and kitchen routing from an admin workflow.
- Support draft/edit/send, add items after send, item/order void with reason and permission, and an auditable order state machine.
- Improve table/area workflows and separate kitchen tickets by station.
- Persist every command locally first; replay idempotently; show pending, synced, and failed states; resolve configuration/version conflicts safely.

**Done when:** cashier and KDS can run on separate devices on the outlet LAN, survive a WAN outage/restart, and reconcile to cloud without duplicate orders or tickets.

### 3. Payments, receipts, and shift close

- Keep cash/manual tender recording explicit; add split tender, refunds/reversals, and immutable payment events.
- Integrate a chosen payment provider/terminal through its supported SDK or API; never store card credentials.
- Add invoice/receipt numbering rules, tax breakdowns, receipt reprint audit, and the chosen printer adapter.
- Add shift open/close, opening float, cash movement, expected-vs-counted reconciliation, and close report.

**Done when:** a pilot cashier can close a shift and reconcile sales by tender; payment outcomes are verifiable and idempotent.

### 4. Pilot reporting and operational hardening

- Sales, tax, tender, item, void/discount, and shift reports with CSV export.
- Device/edge health, sync lag, printer status, retry visibility, backups, restore drill, retention, and support diagnostics.
- Validate supported tablets, browsers, receipt widths, printer models, and offline/reconnect behavior at the pilot outlet.

**Done when:** the pilot owner can reconcile a business day and recover from a device, network, or edge-service restart using documented steps.

### 5. Expand after pilot evidence

- Recipe inventory, stock counts, wastage, purchasing, suppliers, and transfers.
- Delivery/aggregator adapters, QR ordering, loyalty/CRM, reservations, kiosks, accounting integrations, and chain-level controls.
- Scale cloud reporting/analytics and extract services only when measured load or team boundaries justify it.

## Immediate build sequence

1. Select cloud database and identity providers; confirm whether the first pilot should run local-only first or launch with cloud sync from day one.
2. Complete tenant/outlet/staff/terminal data boundaries and authentication before exposing manager operations to a network.
3. Implement outlet setup and managed menu data, replacing demo constants with persisted configuration.
4. Add shift lifecycle and auditable order edits/voids.
5. Build sync protocol and cloud acknowledgements, then deploy the web/control plane to Vercel and run the edge service at the outlet.
6. Validate payment, tax, and printer choices against the pilot's actual hardware and accounting needs.

## Current baseline and known gaps

The repo has a touch POS, demo menu/modifiers, dine-in/takeaway order creation, a basic KDS state update, demo tender recording, IndexedDB order outbox, local SQLite edge storage, WebSocket updates, and a mock ESC/POS TCP printer. A PostgreSQL schema draft exists. Authentication, role enforcement, menu administration, real payment processing, split/refund flows, shift management, cloud persistence/sync, production printer drivers, and operational monitoring are not implemented. The Vercel configuration currently serves a frontend preview only.

## Pilot acceptance checklist

- [ ] Staff sign in and only access assigned tenant/outlet/role.
- [ ] Manager configures menu, taxes, stations, tables, and terminals without code edits.
- [ ] Cashier creates, edits, sends, and closes dine-in/takeaway orders.
- [ ] KDS updates are visible to other outlet devices on the local network.
- [ ] WAN outage and edge restart do not lose accepted orders or create duplicates after reconnect.
- [ ] Payment, invoice, receipt, printer, shift close, and daily totals reconcile on actual pilot hardware.
- [ ] Backup restore and support diagnostics are practiced before pilot use.
