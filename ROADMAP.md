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

**Progress:** the new Supabase project has tenant/outlet/staff/terminal/setup/audit and managed-menu tables with RLS and scoped policies, tracked migrations, and Vercel's browser-safe project URL and publishable key. The owner has confirmed email and created an account-owned tenant, outlet, dining area, tables, and kitchen station. The React manager route supports email/password sign-in, outlet setup, menu management, terminal enrollment UI, and staff invites through a JWT-verified Edge Function. Owner and active outlet-manager roles now see the correct manager tools; outlet-scoped managers can edit outlet name, timezone, currency, configured tax, and receipt name/address/phone/GSTIN/footer through the existing outlet RLS policy. Receipt configuration is included in the same versioned menu/settings snapshot, persisted by the local edge in SQLite, and rendered in ESC/POS receipt output. The email confirmation callback now targets the production manager portal from local development. The local edge uses `POS_*` configuration, request IDs and JSON logs, readiness/integrity checks, and a SQLite backup command.

**Progress:** the outlet edge now exchanges a Supabase access token for an outlet-scoped, signed `HttpOnly` session cookie and enforces owner/manager, cashier, kitchen, and viewer route permissions. Production-mode integration coverage verifies invalid tokens and memberships, cookie tampering, and the permission matrix against a local Supabase Auth/PostgREST simulator. The production signup code passes an explicit Vercel redirect; the owner is signed in on the deployed manager page. The original confirmation link returned to `localhost:3000`; the live Supabase URL Configuration now shows Site URL `https://common-table-pos.vercel.app` and the allowed redirect `https://common-table-pos.vercel.app/admin`. The owner portal remains signed in after a reload. **Still open:** exercise a newly generated confirmation link; the consumed link cannot validate a later settings change. The email-template page did not load in the dashboard session, so its template has not been independently checked. Verify a real invited second user and actual Supabase membership policies against an outlet edge; no pilot terminal has been installed or paired on site. Preview/development Supabase credentials remain intentionally unset. The live owner portal readback still shows the demo account and outlet as expected; settings editing is guarded by manager permissions and has not been used to modify production outlet data during verification.

**Security follow-up:** Supabase's live security advisor reports leaked-password protection disabled. The dashboard confirms that feature requires the Pro plan or above; it remains disabled on the current Free plan, and no plan upgrade or billing change has been made. The terminal-enrollment screen previously retained its one-time key after workspace changes and revocation. The client now clears enrollment credentials on workspace changes, sign-out, and matching terminal revocation; production verification remains pending deployment.

**Pairing protocol:** the terminal-authenticated menu handshake now updates the terminal's cloud `last_seen_at` on both full menu responses and ETag `304` responses. This gives the manager portal a verifiable online signal after the one-time private edge configuration is installed; the portal refreshes terminal status every 15 seconds. The `last_seen_at` write is advisory and cannot block menu delivery or local-first order acceptance. A live smoke test with a temporary key fetched all 43 outlet items (`200`), verified the next unchanged request returned `304`, confirmed `last_seen_at`, and removed the test terminal. That test exposed and fixed Supabase's weak-ETag normalization. The actual pilot terminal still needs to be installed and observed.

**Done when:** a manager can create an outlet, invite staff with roles, enroll a terminal, and see only their authorized outlet data.

### 2. Reliable order and kitchen loop

- Manage menu categories, items, variants/modifiers, availability, and kitchen routing from an admin workflow.
- Support draft/edit/send, add items after send, item/order void with reason and permission, and an auditable order state machine.
- Improve table/area workflows and separate kitchen tickets by station.
- Persist every command locally first; replay idempotently; show pending, synced, and failed states; resolve configuration/version conflicts safely.

**Done when:** cashier and KDS can run on separate devices on the outlet LAN, survive a WAN outage/restart, and reconcile to cloud without duplicate orders or tickets.

**Progress:** outlet-scoped menu categories and items are stored in Supabase; the manager can publish 12 categories and a curated 43-item vegetarian training subset inspired by public Apna Sweets offerings and edit prices/availability. The POS can read that cloud menu for a signed-in browser and cache it for offline display. **Managed-menu hydration now runs on the outlet edge:** an authenticated Supabase function returns the terminal's own outlet snapshot, ETags avoid retransmitting unchanged menus, SQLite replaces the snapshot atomically, removed items become unavailable without breaking historical order foreign keys, and production edges no longer seed fictional menu data. The POS prefers its local edge menu when connected to an outlet edge. **Managed outlet settings now travel in the same snapshot:** name, timezone, currency, and tax rate are included in the version hash and SQLite transaction; settings-only edits therefore refresh paired edges, while existing orders keep their stored currency/tax. Dining areas, tables, capacities, and kitchen stations now share that versioned snapshot; the edge applies them atomically to SQLite, `/api/floor-plan` reports live occupancy from active orders, and the cashier uses the configured areas/tables instead of a hard-coded floor. The browser caches the last accepted layout for offline display. The local end-to-end test covers settings and layout-only updates, active/paid table occupancy, WAN loss, and edge restart. Earlier, Supabase `pos-sync` v5 was deployed and live-tested with a temporary terminal: it returned all 43 items, honored `200`/`304` conditional reads, rejected bad keys (`401`) and browser origins (`403`), and hydrated the real outlet settings into throwaway SQLite. The temporary terminal was revoked and its key then received `401`. **Supabase `pos-sync` v7 is now deployed with floor-plan hydration; its unauthenticated live smoke check returned the expected `401`.** The POS's isolated integration test also covers menu/order availability during WAN loss, persistence after edge restart, and outbox recovery. Cloud remains the menu source of truth; editing/merging menu changes offline is not supported. The local SQLite edge accepts orders with stable command IDs, assigns numbers, records audit events, updates KDS clients over WebSockets, and formats kitchen tickets. A two-tab cashier-to-KDS flow, item modifier, cash demo tender, invoice, receipt, SQLite integrity, and duplicate order/payment retries were exercised against an isolated temporary database. The edge service supports shift open/close, opening float, cash-in/out reasons, tender totals, expected-versus-counted cash, and audit events; closeout balanced to zero variance. **Cloud event sync is implemented:** local transactions append order, payment, shift, cash-movement, and audit events to a durable SQLite outbox; an authenticated Supabase Edge Function stores idempotent append-only events and updates terminal last-seen; retries use backoff; the cashier UI displays queued, failed, and clear states. End-to-end tests created a paid order and balanced shift, verified duplicate command/event delivery, forced terminal-auth failure, then proved recovery after restoring terminal access. **Order edits and station tickets are implemented locally:** additions and reasoned voids are idempotent, audited, synced, and sent to the KDS/printer; tickets split by routed kitchen station and advance independently. The API integration test and isolated browser run passed through a simulated WAN outage and edge restart. New production-mode edge tests validate the role matrix for orders, kitchen, refunds, and reports. **Manager refunds are implemented locally:** partial refunds are capped to the original tender, require an open shift and reason, replay idempotently, and net against shift cash and local reporting. A flow test covers payment, replay, over-refund rejection, CSV/report totals, and zero-variance closeout. **Cloud business projections are now applied:** an append-only event insert and its order/item/payment/shift/cash/audit projection happen in one Postgres transaction; late order snapshots cannot overwrite newer state. `pos-reports` v2 reads normalized projections, with tests for split tenders, refunds on later dates, proportional tax, voids, and closeouts. Real multi-device WAN-down reconnection and real Supabase second-user validation remain open.

**Cashier browser verification (2026-10-25):** found and fixed the saved-order checkout gap: previously a selected unpaid order showed no saved lines and could not be charged. The local browser flow now reopens the order, shows saved items and totals, records payment, updates the tender report, processes a partial refund, and closes the shift at zero variance. This run used a disposable SQLite database and did not write test sales to Supabase.

**Production browser verification (2026-10-25):** after the currency releases, the signed-in owner portal loaded the account, all 43 menu items, and the cloud daily report. The public preview loaded its 43-item cached menu, added a sample item to the temporary cart, and blocked kitchen submission with the outlet-edge requirement; the page was reloaded to clear the cart. No preview order or menu write was made. Vercel production deployment reached `READY`, `/admin` returned HTTP 200, the browser console had no warnings/errors, and Vercel returned no production error logs for the preceding 30 minutes.

### 3. Payments, receipts, and shift close

- Keep cash/manual tender recording explicit; add split tender, refunds/reversals, and immutable payment events.
- Integrate a chosen payment provider/terminal through its supported SDK or API; never store card credentials.
- Add invoice/receipt numbering rules, tax breakdowns, receipt reprint audit, and the chosen printer adapter.
- Add shift open/close, opening float, cash movement, expected-vs-counted reconciliation, and close report.

**Done when:** a pilot cashier can close a shift and reconcile sales by tender; payment outcomes are verifiable and idempotent.

**Progress:** local manager-only partial refunds now create immutable payment events and audit records, enforce the original tender cap, require an open shift, and replay safely. Shift totals and daily reports net the refund. End-to-end test coverage verifies cash refund reconciliation. Live payment processing remains unconnected; tender entries are still manual records.

**Progress:** local SQLite shifts now have deterministic numbers, idempotent open/close commands, an opening float, reasoned cash-in/out events, cash/UPI/card demo tender totals, expected drawer cash, counted cash, variance, and audit records. Payments require an open shift and are associated with it. The local POS dialog shows the shift totals and supports cash reconciliation. This only records manual/demo tenders; no payment provider or live card/UPI flow is connected. Printer output now has explicit `mock`, `network`, and `disabled` modes: the mock is rejected in production and production defaults to disabled; network mode sends raw ESC/POS bytes to a configured TCP printer. The adapter has a local TCP integration test, but no physical printer has been validated. Production tax/invoice rules and the hardware-specific printer setup remain open.

**Progress:** order currency is now stored with every accepted order and follows the configured outlet currency through checkout, manager menu prices, reports, refunds, and receipt output. Regression coverage configures a USD edge and checks persisted orders, plus checks a historical USD receipt remains USD even if the current edge is configured for INR. This supports multi-currency outlet configuration; it does not convert prices or currencies.

### 4. Pilot reporting and operational hardening

- Sales, tax, tender, item, void/discount, and shift reports with CSV export.
- Device/edge health, sync lag, printer status, retry visibility, backups, restore drill, retention, and support diagnostics.
- Validate supported tablets, browsers, receipt widths, printer models, and offline/reconnect behavior at the pilot outlet.

**Done when:** the pilot owner can reconcile a business day and recover from a device, network, or edge-service restart using documented steps.

**Progress:** the edge exposes a daily report screen and CSV endpoint backed by local SQLite. An authenticated Supabase `pos-reports` Edge Function v2 reads normalized, RLS-scoped business projections; it computes outlet-timezone totals and supports CSV export. Pure aggregation tests cover split tender, proportional refund tax, later-day refunds, voids, and shift close; local report tests cover date boundaries and CSV output. The manager report UI is deployed on Vercel and was exercised in the signed-in owner session; the live report correctly shows zero sales because no live production sales have been recorded or synced. Cloud projections are live. The SQLite backup command now validates the staged backup's own integrity, foreign keys, and outlet identity before publishing it; the automated restore exercise verifies recovered data and the pre-restore safety copy. Production alerting and a real outlet restore drill remain open.

### 5. Expand after pilot evidence

- Recipe inventory, stock counts, wastage, purchasing, suppliers, and transfers.
- Delivery/aggregator adapters, QR ordering, loyalty/CRM, reservations, kiosks, accounting integrations, and chain-level controls.
- Scale cloud reporting/analytics and extract services only when measured load or team boundaries justify it.

## Immediate build sequence

1. (Done) Create a dedicated Supabase POS project; configure Vercel's public client settings without exposing privileged keys.
2. (Foundation done) Establish tenant/outlet/staff/terminal data boundaries and authentication before exposing manager operations to a network; finish real-user verification and edge pairing.
3. (Done) Pull the outlet's managed menu into SQLite atomically; use a cloud snapshot hash and ETags to avoid stale or repeated downloads. Cloud remains the source of truth, so offline menu edits and merges are not supported.
4. (Shift lifecycle done) Add auditable shifts, cash reconciliation, and cash movement controls.
5. (Local workflow and simulated RBAC tested) Add audited order additions/voids, station-specific KDS tickets, partial refunds, reports, and role guards; validate against a second real staff account before pilot use.
6. (Sync protocols deployed and locally tested) Deploy current source, verify Supabase Auth URL configuration, pair a real outlet terminal, and run its edge service on site.
7. Validate payment, tax, and printer choices against the pilot's actual hardware and accounting needs.

## Current baseline and known gaps

The repo has a touch POS, a 43-item Indore vegetarian training menu inspired by a public Apna Sweets listing, dine-in/takeaway order creation and additions, Supabase-managed floor plans with local caching and occupancy, station-specific KDS tickets and transitions, audited demo voids with reasons, manual tender recording, partial manager refunds, local daily reports with CSV, IndexedDB outbox, local SQLite edge storage, WebSocket updates, a mock ESC/POS printer and configurable raw-TCP network adapter, outlet-scoped cloud menu administration, atomic managed-menu/settings/layout hydration, shift reconciliation, durable business-event sync, signed edge staff sessions, and role guards. Stored order currency is rendered through cashier settlement, refunds, menu management, reports, and receipts. The Supabase cloud report function reads normalized projections; the authenticated manager report UI and terminal status polling are deployed to production. The Vercel app cannot process orders or display current local outlet reports without an outlet edge; cashier, KDS, and local reports must use the edge-hosted app on the outlet network. Supabase Auth URL Configuration is verified for the production manager route; a fresh confirmation-link check remains open. A real terminal install/pairing, real second-user validation, live payment-provider integration, tax/invoice compliance, physical printer validation, cloud operations alerts, and an on-site multi-device/recovery drill remain open. Phase 5 inventory, purchasing, transfers, delivery, loyalty, reservations, and accounting features have not started.

## Pilot acceptance checklist

- [ ] Staff sign in and only access assigned tenant/outlet/role.
- [ ] Manager configures menu, taxes, stations, tables, and terminals without code edits.
- [ ] Cashier creates, edits, sends, and closes dine-in/takeaway orders.
- [ ] KDS updates are visible to other outlet devices on the local network.
- [ ] WAN outage and edge restart do not lose accepted orders or create duplicates after reconnect.
- [ ] Payment, invoice, receipt, printer, shift close, and daily totals reconcile on actual pilot hardware.
- [ ] Backup restore and support diagnostics are practiced before pilot use.
