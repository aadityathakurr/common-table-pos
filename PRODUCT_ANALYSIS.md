# Restaurant POS Product Analysis and Build Plan

**Prepared:** 25 October 2026  
**Reference product:** Petpooja POSS, public product pages  
**Workspace:** this directory had no application source or Git repository when inspected.

## Executive summary

Petpooja POSS is presented as a restaurant operations platform built around fast billing. The public feature set extends into table and kitchen operations, inventory and recipes, online orders, customer engagement, reporting, hardware support, integrations, and multi-outlet administration. The core product loop is: **take an order → route preparation → track fulfilment → bill and collect payment → update stock and reports**.

For a new product, build a dependable single-outlet POS first. Prioritize order entry, KOT/KDS, payments, receipts, shift close, audit history, and offline recovery. Add recipe inventory, online ordering integrations, loyalty, and chain controls after the core loop is reliable in a real restaurant. Trying to match every advertised add-on in the first release would multiply hardware, compliance, integration, and support work before the essential workflow is proven.

This report uses Petpooja's **public marketing pages** as product evidence. It does not claim access to Petpooja's private software, source code, APIs, or authenticated cashier screens.

## Investigation and evidence boundary

- **REA controlled browser capture:** Chromium opened `https://www.petpooja.com/poss`, waited for page load, and captured DOM, accessibility, URL, screenshot, and console/page-error event families. Evidence ID: `ev_32faa9ef02e06a678a82a66638e7673ab1e92b18057c5e21515880de6827ec9f`. Capture completed without truncation. It confirms the public page structure and content only; no POS order or payment action was exercised.
- **Official feature pages:** billing, inventory, menu, KDS, online ordering, offline POS, pricing, integrations, CRM, Captain app, QR ordering, loyalty, analytics, fine-dining, QSR, and chain pages were reviewed. Claims below describe what those pages advertise; they are not independent performance verification.
- **Unavailable evidence:** authenticated POS workflows, printer/payment terminal behavior, offline conflict handling, API contracts, detailed permission matrices, and actual reliability/performance were not publicly inspectable in this pass.
- **REA scope:** the relevant browser scenario tool was used. Native binary, firmware, mobile-package, traffic-capture, and code-decompilation tools do not apply because no Petpooja app package or captured traffic was supplied. The marketing site's JavaScript is not the restaurant POS product and was not treated as product implementation evidence.

## Product map: what the public product pages describe

| Area | Advertised capability | Why it matters in a build |
|---|---|---|
| Billing and order entry | Fast item entry, bills, KOTs, discounts/coupons, split payments, table merge/split, custom receipt, tax configuration, multiple terminals | This is the cashier's high-frequency workflow and the system's financial source of truth. |
| Restaurant floor | Areas, tables, seating layouts, table-wise orders, move/merge/split orders, reservations on some plans | Needed for dine-in service and accurate table ownership. |
| Menu | Categories, variations, add-ons, combos, shortcodes, multiple menus and prices by area/channel | Orders must retain the menu/price/modifier version that applied when they were placed. |
| Kitchen | Station/category-based KOT routing, printer assignment, KDS, individual tickets and aggregated item views, ready status, sold-out controls | Kitchen work is a stateful queue, not just a print operation. |
| Inventory | Recipe-based ingredient deduction, multi-stage recipes, low-stock alerts, purchase orders, supplier/central-kitchen movement, returns, FIFO claims | Stock requires units, conversions, recipe yields, wastage, and a ledger of movements. |
| Online/delivery | Aggregator orders in one screen, online menu availability and price updates, order status, packaging charges, payment/payout reconciliation | Each sales channel has different identifiers, fees, timing, and failure modes; integrations need adapters. |
| Customer / CRM | Unified customer history across channels, labels, notes, campaigns, feedback, loyalty and wallet | Useful after checkout is reliable; requires consent, access controls, and careful personal-data handling. |
| Reports | Sales, taxes, online orders, inventory consumption, staff actions, discounts/cancellations, cash drawer, exports and dynamic reports | Reports should derive from auditable events and reconcile to tender and tax totals. |
| People and control | Roles and user rights, staff activity and bill-modification/cancellation reports | Sensitive actions need explicit permissions, reasons, and audit records. |
| Multi-outlet | Head-office view, zones, central menu/inventory masters, outlet-level monitoring and ERP links | Requires tenant/outlet scoping, versioned central configuration, and offline sync conflict rules. |
| Add-ons / ecosystem | Captain ordering app, QR order, kiosk, token display, loyalty, customer feedback, website, Tally/ERP and other integrations | These are separate clients/services that should use stable shared order and menu APIs. |
| Deployment / hardware | Public pages claim offline/cloud operation and support across hardware/operating systems; the offline page describes local storage with later sync | Offline-first operation and peripherals are product requirements, not polish. The exact supported-device matrix remains unknown. |

The product is positioned for cafés, QSRs, fine dining, food courts, bakeries, bars, cloud kitchens, and chains. Those formats share billing and menu primitives, but differ in table service, ticket routing, delivery, inventory depth, and outlet management.

## Key workflows to model

### 1. Dine-in sale

1. Staff opens a shift and selects an area/table or starts a walk-in order.
2. Staff adds menu items, quantities, variants, add-ons, notes, and discounts.
3. The POS stores the order locally and routes item lines to the configured kitchen stations.
4. Kitchen staff accept/start/ready items on KDS or through station tickets; the floor sees status.
5. Staff can add items, move or merge tables, split guests/items, or void with permission and reason.
6. Cashier calculates the final tax/charges, splits tender if needed, records payment, and issues/prints the receipt.
7. The closed sale updates shift totals, reports, customer history, and recipe stock movements.

### 2. Counter / takeaway sale

1. Cashier creates a counter order, applies modifiers and offers, and records dine-in/takeaway tax/service context.
2. POS issues a queue/token number and routes preparation tickets.
3. KDS marks items ready; token display or staff hands over the order.
4. Tender and receipt close the order; cancellation/refund follows a permissioned reversal flow.

### 3. Delivery / aggregator order

1. A channel adapter receives an order using the provider's external order ID and idempotency key.
2. The POS maps provider menu items/modifiers and charges to internal menu IDs, preserving unmapped-order exceptions.
3. Staff accepts/rejects according to policy; accepted items route to KDS.
4. Status updates are returned where supported; retries must not create duplicate kitchen tickets.
5. Reconciliation matches gross order value, discounts, tax, commissions, adjustments, and payout.

### 4. Purchasing and stock

1. Configure ingredients, units, conversions, suppliers, recipes/yields, and reorder thresholds.
2. Create purchase order, receive actual quantities/costs, and record invoice/reference.
3. Sales create ingredient consumption movements from the recipe version active at sale time.
4. Staff records waste, spoilage, transfers, returns, stock counts, and corrections as separate movements.
5. Variance and low-stock reports explain theoretical usage versus counted stock.

### 5. Shift close and reconciliation

1. Record opening float, cash in/out, refunds, and all tender events.
2. Count physical cash and compare against expected cash; require a reason for adjustments.
3. Close the shift with sales/tax/discount/refund/tender totals and unresolved-order warnings.
4. Keep a read-only audit trail linking each total to source transactions.

## Recommended first release

**Assumption:** start with one Indian restaurant using dine-in plus takeaway. Validate this assumption with the first pilot; a delivery-only kitchen or multi-outlet chain would change sequencing.

### Must ship for a useful pilot

- Outlet setup, tax/receipt settings, users, roles, terminals, and open/close shift.
- Menu categories, items, variants, add-ons, availability, and simple discounts.
- Order lifecycle for dine-in and takeaway; tables/areas; add, edit, void with permission; split/merge tables and bills.
- KOT routing by kitchen station, printer output, and a kitchen screen with new/in-progress/ready states.
- Cash and manual external-tender recording; split tender; refund/reversal; receipt reprint with audit.
- Offline order entry, local persistence, and safe sync after reconnection. Clearly show sync state and unresolved conflicts.
- Daily sales, tender, tax, item, void/discount, and shift-close reports.
- Device pairing and recovery documentation for the actual pilot printer, cash drawer, and payment terminal.

### Defer until the pilot is stable

Recipe inventory and purchase workflow; aggregator connections; QR ordering; customer CRM and loyalty; advanced analytics; central kitchen; chain-level menu push; reservations; kiosk; ERP/accounting integration; AI features. These are valuable, but add domain, vendor, and support dependencies.

## Suggested architecture (design recommendation, not Petpooja internals)

Start with a **modular monolith** and explicit domain boundaries. This keeps the initial system straightforward to operate while leaving seams for separate services when load or team ownership warrants it.

```text
Cashier POS / Kitchen Display / Admin dashboard / optional Captain client
                              |
               Local order store + durable outbox
                              |
             Sync/API layer with idempotent commands
                              |
       Domain modules: Orders | Menu | Payments | Kitchen
       Tax/Receipts | Inventory | Users/Audit | Reporting
                              |
     Relational database + append-only business event/audit log
                              |
       Adapters: printers | payment terminals | channels | ERP
```

### Offline and sync design

- Keep active menu/configuration and current outlet data available locally; create orders and kitchen tickets without a cloud round trip.
- Persist each user command with a stable device ID, command/event ID, outlet ID, local sequence, and timestamp before acknowledging it in the UI.
- Sync through a durable outbox; make server-side commands idempotent and retryable. Preserve local receipt/order numbers and expose sync state.
- Treat closed financial documents as immutable. Corrections become void/refund/credit/reversal events with actor, reason, and linkage to the original.
- Define conflict rules per object: central menu changes can be versioned and pulled; two devices editing the same open order need explicit ownership/merge behavior; never silently overwrite tenders or closed bills.
- Decide which operations are allowed offline. Payment-terminal authorization, aggregator acceptance, SMS/OTP, loyalty balance redemption, and tax portal reporting may require connectivity or deferred status.

### Core data model

`Tenant → Brand → Outlet → Area → Table`; `User → Role → Permission`; `Menu → MenuVersion → Category → Item → Variant/AddOn/Combo`; `Order → OrderLine → Modifier → KitchenTicket → TicketLine/StatusEvent`; `Bill/Invoice → TaxLine → Tender/Refund`; `Shift → CashMovement`; `RecipeVersion → Ingredient → UnitConversion → StockMovement → PurchaseOrder/Receipt`; `Customer → Consent → LoyaltyLedger`; `Integration → ExternalOrder/Mapping/SyncAttempt`; `AuditEvent`.

Use stable IDs, outlet/time-zone context, currency, tax context, and created/updated actor fields. Store order-line snapshots (name, price, tax rule, modifiers) so later menu edits do not rewrite historical bills. Use a stock and loyalty ledger rather than mutable balances as the only record.

### Non-functional requirements

- **Speed:** item search/add and KOT dispatch must work with local latency; instrument the real checkout path.
- **Reliability:** durable writes, idempotency, retry queues, printer failure visibility, backup/restore, and recovery drills.
- **Security:** tenant/outlet isolation, least-privilege roles, device pairing, encrypted transport/storage, secrets management, session expiry, and audit for sensitive changes.
- **Financial correctness:** decimal/fixed-point money, deterministic rounding, explicit tax inclusive/exclusive semantics, immutable closed bills, reconciliation, and exportable audit evidence.
- **Privacy:** collect only needed customer data, record consent and retention policy, restrict access, and secure backups.
- **Operations:** health/sync status, device diagnostics, versioned configuration, support bundle that excludes sensitive payment data, and controlled upgrades.

## India-specific requirements to settle early

- Build a configurable tax and invoice engine; do not hardcode rates or tax assumptions into the UI. The invoice needs the applicable supplier/recipient and line/tax details. CBIC invoice rules list supplier identity, invoice numbering/date, recipient details where applicable, HSN/service code, description, quantity, value, and tax particulars. Confirm the exact restaurant use cases with a qualified GST professional and current official guidance before launch. [CBIC invoice rules](https://cbic-gst.gov.in/gst-invoice-rules.html)
- Treat e-invoice as a separate eligibility-gated integration, not a synonym for printing an invoice. GSTN describes reporting specified documents to an Invoice Registration Portal for validation and IRN/QR issuance; applicability depends on current notifications and taxpayer circumstances. [GSTN e-invoice overview](https://tutorial.gst.gov.in/downloads/news/e_invoice_overview.pdf)
- Store amounts, rates, tax splits, rounding policy, document series, outlet GST identity, and applicable tax-rule version on the finalized document. Keep tax-rule updates configurable and effective-dated.
- Confirm payment provider integration and PCI scope with the selected provider. Prefer terminal/provider tokenization; do not store card credentials.

## Build sequence and decision gates

1. **Discovery:** observe one real service shift with owner, cashier, waiter, and kitchen staff. Confirm restaurant type, internet quality, tax/accounting process, printers, number of terminals, payment provider, void/refund policies, and required sales reports.
2. **Prototype:** validate cashier/KDS screens with realistic menu size, modifiers, touch targets, shortcuts, kitchen station mapping, and receipt layout.
3. **Pilot core:** implement menu → order → KOT/KDS → bill/payment → receipt → shift close, with offline persistence and audit from the start.
4. **Shadow run:** compare totals, tax, tenders, KOTs, and stock counts against the restaurant's existing process; correct discrepancies before relying on it for all sales.
5. **Operational hardening:** test network loss/reconnect, power loss, duplicate retries, printer unplugged, terminal timeout, refund, and backup restoration.
6. **Expand by validated demand:** add inventory/purchasing, delivery connectors, CRM/loyalty, then multi-outlet controls and partner APIs.

### Acceptance checks for the pilot

- Every order and KOT survives app restart and network interruption without duplication or silent loss.
- A finalized receipt can be reproduced; totals reconcile exactly by tender, tax, discounts, refunds, and shift.
- Kitchen sees each item at the correct station with modifiers and notes; ready/void/add-on updates are traceable.
- A cashier cannot perform a restricted discount, void, refund, or drawer adjustment without authorized approval and a reason.
- Staff can recover from a failed printer/payment response without creating duplicate orders or payments.

## Open product decisions

1. Is the first customer a single outlet, a chain, or a cloud kitchen?
2. Which order modes must ship first: table service, takeaway, delivery, QR, or all three core modes?
3. Is internet loss common enough to require full local-first billing, or is a limited offline mode acceptable?
4. Which exact devices and printer protocols must be supported at launch?
5. Which payment provider, aggregator, GST/e-invoice path, and accounting export are required?
6. Is inventory part of MVP, and will recipes be maintained by restaurant staff?
7. What is the target pricing model: per outlet, terminal, module, or transaction?

Petpooja's public pricing page currently displays a base plan and separate operations/marketing bundles, while stating that plans are indicative and subject to change. It does not establish a durable price benchmark or reveal a competitor's internal cost structure. Use it only as a current page snapshot, then price against support, hardware, integrations, and customer value. [Petpooja pricing page](https://www.petpooja.com/poss/pricing)

## Sources reviewed

- [Petpooja POSS overview](https://www.petpooja.com/poss)
- [Billing](https://www.petpooja.com/poss/restaurant-billing-software), [inventory](https://www.petpooja.com/poss/restaurant-inventory-management-software), [menu management](https://www.petpooja.com/poss/restaurant-menu-management-software)
- [Kitchen Display System](https://www.petpooja.com/poss/kitchen-display-system), [online order management](https://www.petpooja.com/poss/online-order-management-software), [offline POS](https://www.petpooja.com/offline-pos)
- [Captain app](https://www.petpooja.com/poss/captain-ordering-app), [Scan & Order](https://www.petpooja.com/poss/scan-and-order), [CRM](https://www.petpooja.com/poss/restaurant-customer-management-software), [loyalty](https://www.petpooja.com/poss/restaurant-loyalty-program)
- [Reports and analytics](https://www.petpooja.com/poss/reports-and-analytics), [integrations](https://www.petpooja.com/poss/restaurant-integrations), [fine dining](https://www.petpooja.com/poss/fine-dine-restaurant-pos-software), [QSR](https://www.petpooja.com/poss/quick-service-restaurant-software), [large chains](https://www.petpooja.com/poss/large-chain-restaurant-pos-software)
- [CBIC invoice rules](https://cbic-gst.gov.in/gst-invoice-rules.html), [GSTN e-invoice overview](https://tutorial.gst.gov.in/downloads/news/e_invoice_overview.pdf)
