# Common Table POS: cashier and manager guide

This guide describes the current prototype workflow for one cafe/QSR cashier laptop. Orders are written to that laptop's SQLite database first. Internet is needed for the first staff sign-in, cloud menu/setup downloads, and background sync; an outage after sign-in does not stop local order taking.

## Before the shift

1. Start the Common Table service on the cashier laptop. On Linux with the user service installed, it starts at desktop login. Otherwise run `npm start` from the project folder.
2. On that same laptop, open `http://localhost:3001/admin` and sign in while online. Supabase checks the account and its outlet role; the local service then creates a signed, HttpOnly session cookie. The laptop renews that session locally while it is being used. It survives browser and service restarts, and it works without internet until 30 days of inactivity or an explicit sign-out. If access is revoked while this laptop is offline, the laptop can only learn about that after it reconnects.
3. Open `http://localhost:3001/` for the Point of Sale page. Confirm the outlet name and edge connection indicator. The first online setup should have already downloaded the menu, tax/settings snapshot, tables, and kitchen stations to local SQLite.
4. Open the shift, enter the actual starting cash float, and confirm. The app assigns a shift number and records the float.

## Take and complete an order

1. In **Point of sale**, choose **Dine in** and a free table, or choose **Takeaway**.
2. Search or browse the menu and tap items to add them. Select modifiers when offered; adjust quantities or remove items from the cart as needed.
3. Add an order note if the kitchen needs one. Check the item list, tax, and total.
4. Tap **Send to kitchen** to save the order locally and create the kitchen ticket. The ticket appears in **Kitchen display** on this laptop. A separate tablet can be connected over the same local network if the outlet chooses to use one, but that is optional.
5. In the kitchen display, move a ticket through **Preparing** and **Ready**. Return to Point of sale, select the open order, and choose **Take payment** when it is time to settle.
6. Choose cash, UPI, card, or a split tender and record the payment. The app assigns an invoice number, saves a receipt record, and queues receipt output if a printer is configured.

### UPI in this version

UPI is a manual tender entry. The cashier confirms receipt of payment and records the amount. Common Table does not create a QR request, contact a payment provider, or verify a bank transfer. No payment gateway is connected. The recorded payment is a POS record and should be reconciled against the outlet's normal UPI statements.

## Internet outage and reconnection

- Keep using the same installed cashier laptop and browser profile. Orders are stored in its local SQLite database; unsent browser commands use that browser profile's IndexedDB queue and retry with stable command IDs.
- The local session, cached menu, floor plan, current orders, kitchen display, and reports continue to work while the WAN is unavailable, as long as the laptop and its local service are running.
- Internet is required again for new Supabase sign-in or access changes, menu/configuration refresh, and cloud synchronization. Queued business events retry after reconnection.
- A single laptop does not require Wi-Fi or a second edge server. If the service process restarts, it reopens the same persistent local database. A second device can share live orders only when it can reach the cashier laptop over a LAN; it is not required for the one-cashier setup.

## End of shift and reports

1. In the shift panel, record any cash paid in or out with a reason.
2. Count the drawer and enter the cash counted. Compare the expected amount and variance, then close the shift.
3. Open **Daily reports** to check paid orders, subtotal, tax breakdown, tenders, refunds, items, voids, and closed-shift reconciliation. Use the CSV export for a spreadsheet.
4. The daily report is read from the cashier laptop's SQLite database. The manager's cloud report only includes records that have synchronized.

## Manager setup and inventory

- Use `https://common-table-pos.vercel.app/admin` while online for manager sign-in, outlet setup, menu changes, staff membership, terminal enrollment, and cloud reports.
- Enroll a cashier laptop as a terminal and put its one-time configuration in that laptop's private `.env` file. Do not share or commit that file; it contains the terminal sync credential and local session-signing secret.
- Inventory is an optional manager workflow. Add actual stock items before recording receipts, waste, or counts. The demo outlet starts with no invented stock balance.

## Receipts, backups, and help

- Development uses a mock printer. Production printing defaults to disabled until a supported network printer is explicitly configured. Test the actual printer, paper width, character output, cutter, and drawer behavior before service; a successful socket send does not prove paper came out.
- Production mode keeps daily integrity-checked SQLite backups on the cashier laptop. Configure an encrypted external disk for `POS_BACKUP_DIR` if the outlet needs protection from laptop loss. Practice restoring a backup before relying on it.
- Check service health at `http://localhost:3001/api/ready`. Managers can download `http://localhost:3001/api/support/diagnostics.json` from the local edge for non-sales troubleshooting details.

## Current boundaries

This is still a pilot prototype. The sample menu and default tax are training data and must be reviewed by the outlet before commercial use. Invoice/tax compliance, a real second-user invite, physical printer validation, terminal pairing at the cafe, and an on-site restore drill remain pilot checks. Cash/card tender entries are also records only; no provider transaction is processed. Supplier and purchase-order workflows are outside the agreed product scope.
