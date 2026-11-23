# Credit ledger and usage

Issue #6 owns platform credit accounting. Payment-provider verification is deliberately separate in #19.

## Server contract

Apply `db/migrations/0004_credit_ledger.sql` after the account and entitlement migrations. The maintained `scripts/migrate-platform-auth.mjs` does this automatically.

Every wallet-changing operation is resolved against a server-owned user ID and a stable operation key. PostgreSQL locks the user's wallet row before checking or changing availability, so concurrent holds cannot both spend the same credits.

The ledger supports:

- exactly-once starter grants from account provisioning;
- purchase and subscription allocations for verified billing adapters;
- atomic reservations before managed work is enqueued;
- actual-usage capture and unused reservation release;
- refunds and reversals with an audit reason;
- signed administrative adjustments with an audit reason;
- optional expiry entries with an audit reason.

`reserveCredits` accepts a trusted maximum cost. `reserveEstimatedCredits` first sums server-priced maximum-cost components with `estimateMaximumCredits`; it does not contain or invent provider prices. Future generation services should calculate their configured ceilings, reserve before enqueueing, then call `settleCredits` with actual usage. A zero-credit failed settlement requires a reason and releases the whole reservation.

Purchase, subscription, refund, adjustment, reversal and expiry writers use `recordCreditEntry`. Replaying the same user + operation + kind with identical data returns the existing result. Reusing it with different data is rejected.

## Meter semantics

The persisted meter exposes:

- **settled balance** — grants and settled debits/credits;
- **reserved** — active holds;
- **available** — settled balance minus active holds;
- **spent** — captured managed usage.

Reserve and release rows are retained as audit events but do not alter settled balance. Negative adjustments or expiry are rejected if they would make available credits negative while another operation is holding credits.

## User entry points

Both Free and Premium members can read GET `/api/platform/v1/usage` and open `/usage` or `/zh/usage`. The response is derived from the verified session; query parameters or provider API keys cannot select another member.

Premium-effective accounts can additionally read GET `/api/platform/v1/usage/history`. It returns the caller's newest ledger entries with operation key, reason, tool, model, job and top-up metadata. History is paginated by the opaque numeric `nextBefore` cursor. Free accounts receive 403 for the detailed endpoint while retaining the basic meter.

## Verification

The platform CI runs:

```bash
npm test
bash tests/platformAccounts.pg.sh
node --test tests/platformAuth.integration.mjs
npm run build:packages
npm run build
node --test tests/platformAuth.http.mjs tests/platformEntitlements.http.mjs
npx --no-install playwright test --workers=2
npx --no-install playwright test -c playwright.accounts.config.mjs
```

The PostgreSQL suite applies the credit migration twice to verify replay safety. Its acceptance fixture gives a user 10 credits, races two reservations of 8, confirms only one succeeds, captures 5, releases 3 and replays settlement with 5 credits still available. It also covers a zero-capture failure/retry, all supported ledger event kinds, active-hold protection and exactly-once starter grants.

A separate ledger-writing database role needs `UPDATE (ledger_revision)` on `platform.credit_wallets`. Wallet entries advance a per-wallet revision in the same transaction as the ledger append. A worker using repeatable-read or serializable isolation should retry its entire transaction on PostgreSQL SQLSTATE `40001`. The next attempt reads the committed balance. Operation keys can include colons in both account and job IDs. Existing ledger rows retain their original identifiers.
