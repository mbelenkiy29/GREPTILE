# payments-service

A small invoicing API used by the OpenReview demo (`pnpm demo`). Accounts have members with roles; admins issue
invoices, which apply an optional coupon discount and regional sales tax.

- `src/auth` — session parsing and role checks
- `src/billing` — pricing (discounts, tax) and invoice building
- `src/db` — a minimal data layer (an in-memory implementation is used in tests)
- `src/routes` — HTTP handlers
- `test` — unit tests (`node --test`)

All amounts are integer cents.
