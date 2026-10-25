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

### 0. Pilot definition and architecture (complete)

- First outlet: Indian cafe/QSR with dine-in and takeaway; devices: browser on tablets and laptops.
- Orders must be accepted locally during internet outages and sync later; the outlet edge owns local order acceptance, KDS, numbering, and printer access.
- Hosting: Vercel for the hosted web/control plane; Supabase for cloud Postgres and Auth; SQLite remains the outlet database.
- Live payment processing is deferred until phase 3, when the pilot's payment terminal/provider is selected.

**Complete:** pilot scope, offline boundary, and providers are agreed. A dedicated Supabase project (`common-table-pos`) is active in Mumbai (the creation quote was $0); the unrelated split-bill project remains untouched.

### 1. Production foundation (in progress)

- Add real sign-in, tenant/outlet membership, role permissions, staff identities, and terminal enrollment. Remove hardcoded demo identity from request handling.
- Add migrations and configuration for both local SQLite and cloud Postgres; make tenant/outlet scoping mandatory in repository operations.
- Add outlet setup: timezone, currency, tax configuration, receipt identity, dining areas/tables, and kitchen stations.
- Add secrets handling, structured logs, request IDs, health/readiness checks, backup/restore notes, and development/staging/production environments.

**Progress:** the new Supabase project has tenant/outlet/staff/terminal/setup/audit and managed-menu tables with RLS and scoped policies, tracked migrations, and Vercel's browser-safe project URL and publishable key. The owner has confirmed email and created an account-owned tenant, outlet, dining area, tables, and kitchen station. The React manager route supports email/password sign-in, outlet setup, menu management, terminal enrollment UI, and staff invites through a JWT-verified Edge Function. The email confirmation callback now targets the production manager portal from local development. The local edge uses `POS_*` configuration, request IDs and JSON logs, readiness/integrity checks, and a SQLite backup command.

**Still open:** staff invitation and role enforcement have not been verified with a second user. The cloud terminal table is empty; terminal enrollment, one-time key storage, local pairing, revocation, and per-staff authorization at the edge still need implementation and tests. The Supabase Auth dashboard Site URL and redirect allowlist still need a dashboard check. Preview/development Supabase credentials are intentionally unset. Step 1 remains in progress until staff and a terminal are actually paired to the local edge.

**Done when:** a manager can create an outlet, invite staff with roles, enroll a terminal, and see only their authorized outlet data.

### 2. Reliable order and kitchen loop

- Manage menu categories, items, variants/modifiers, availability, and kitchen routing from an admin workflow.
- Support draft/edit/send, add items after send, item/order void with reason and permission, and an auditable order state machine.
- Improve table/area workflows and separate kitchen tickets by station.
- Persist every command locally first; replay idempotently; show pending, synced, and failed states; resolve configuration/version conflicts safely.

**Done when:** cashier and KDS can run on separate devices on the outlet LAN, survive a WAN outage/restart, and reconcile to cloud without duplicate orders or tickets.

**Progress:** outlet-scoped menu categories and items are stored in Supabase; the manager can publish 12 categories and 43 fictional training items and edit prices/availability. The POS can read that cloud menu for a signed-in browser and cache it for offline display. The local SQLite edge accepts orders with stable command IDs, assigns numbers, records audit events, updates KDS clients over WebSockets, and formats kitchen tickets. A two-tab cashier-to-KDS flow, item modifier, cash demo tender, invoice, receipt, SQLite integrity, and duplicate order/payment retries were exercised against an isolated temporary database. The edge service now also supports shift open/close, opening float, cash-in/out reasons, tender totals, expected-versus-counted cash, and audit events. UI and API closeout tests balanced cash to zero variance; SQLite integrity and foreign keys passed after restarting the edge process. Local edge sync to cloud, order edits/void reasons, and WAN-down KDS reconnection still remain open.

### 3. Payments, receipts, and shift close

- Keep cash/manual tender recording explicit; add split tender, refunds/reversals, and immutable payment events.
- Integrate a chosen payment provider/terminal through its supported SDK or API; never store card credentials.
- Add invoice/receipt numbering rules, tax breakdowns, receipt reprint audit, and the chosen printer adapter.
- Add shift open/close, opening float, cash movement, expected-vs-counted reconciliation, and close report.

**Done when:** a pilot cashier can close a shift and reconcile sales by tender; payment outcomes are verifiable and idempotent.

**Progress:** local SQLite shifts now have deterministic numbers, idempotent open/close commands, an opening float, reasoned cash-in/out events, cash/UPI/card demo tender totals, expected drawer cash, counted cash, variance, and audit records. Payments require an open shift and are associated with it. The local POS dialog shows the shift totals and supports cash reconciliation. This only records manual/demo tenders; no payment provider or live card/UPI flow is connected. Production tax/invoice rules and a physical printer driver remain open.

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

1. (Done) Create a dedicated Supabase POS project; configure Vercel's public client settings without exposing privileged keys.
2. (Foundation done) Establish tenant/outlet/staff/terminal data boundaries and authentication before exposing manager operations to a network; finish real-user verification and edge pairing.
3. Implement managed menu data and connect the cashier UI to persisted outlet configuration.
4. Add shift lifecycle and auditable order edits/voids.
5. Build sync protocol and cloud acknowledgements, then deploy the web/control plane to Vercel and run the edge service at the outlet.
6. Validate payment, tax, and printer choices against the pilot's actual hardware and accounting needs.

## Current baseline and known gaps

The repo has a touch POS, a 43-item fictional Indore vegetarian training menu, dine-in/takeaway order creation, a basic KDS state update, demo tender recording, IndexedDB outbox, local SQLite edge storage, WebSocket updates, mock ESC/POS TCP printing, outlet-scoped cloud menu administration, and local shift reconciliation. The Vercel POS preview can display the cloud menu but cannot process orders without an outlet edge; cashier and KDS clients must use the edge-hosted web app on the outlet network. Local-to-cloud order synchronization, terminal pairing and staff authorization at the edge, order edits/void reasons, real payment processing, split/refund flows, production printer drivers, and operational monitoring are not implemented.

## Pilot acceptance checklist

- [ ] Staff sign in and only access assigned tenant/outlet/role.
- [ ] Manager configures menu, taxes, stations, tables, and terminals without code edits.
- [ ] Cashier creates, edits, sends, and closes dine-in/takeaway orders.
- [ ] KDS updates are visible to other outlet devices on the local network.
- [ ] WAN outage and edge restart do not lose accepted orders or create duplicates after reconnect.
- [ ] Payment, invoice, receipt, printer, shift close, and daily totals reconcile on actual pilot hardware.
- [ ] Backup restore and support diagnostics are practiced before pilot use.
