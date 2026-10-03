# Trialguard

**Never pay for a trial you forgot.** Trialguard finds every recurring charge and free trial a person has, warns them 48h and 24h before a trial converts or a renewal charges, and helps them cancel. A cancellation counts as done only after the next statement shows no charge.

This repo is the MVP from the PRD: the P0 features plus the P1 detection features that come almost free once the pipeline exists (price-hike alerts and the post-cancel check).

## Quick start

```bash
npm install
npm run dev        # API on :8787 + web app on :5173 (open http://localhost:5173)
npm test           # 41 tests: core engine + end-to-end API
npm run typecheck
```

Production-style single server: `npm start` builds the web app and serves it from the API on `:8787`.

Bank and inbox connections default to **sandbox mode**. The sandbox generates realistic data relative to today: Netflix with a price hike, Spotify billed through PayPal, two App Store subscriptions, an unknown gym, a lapsed Hulu, coffee and grocery noise, and four trial signup emails. You can run the whole flow without real accounts.

Requires Node ≥ 22.18. The API and core run TypeScript directly through Node's type stripping, so they have no build step.

## Layout

```
packages/core   Pure detection engine (no I/O). Everything below is unit-tested.
  merchants.ts    Merchant catalog: descriptor patterns, email domains, cancel URL + steps (seed of the top 200)
  normalize.ts    "NFLX*Netflix 866-579 CA" → Netflix; sees through PayPal / App Store / Google Play
  recurring.ts    F1  recurring-charge detection by merchant, amount and cadence; price history
  email.ts        F2  email filter (which emails we read) + rules-based extraction of trial / receipt / price / cancel emails
  reconcile.ts        merges bank + email + manual into one item per subscription across its whole life
                      (trial → paid → cancel pending → verified, or charged after cancel)
  alerts.ts       F4  48h/24h alerts, late catch-up, Free-plan cap of 3 trials; event alerts (price hike, post-cancel charge)
  cancel.ts       F5  cancel plan: deep link, steps, billing-rail routing, state auto-renewal rights (CA, NY, CO, VT, VA + ROSCA)
  savings.ts      F7  monthly/yearly totals, saved so far, verified savings
  plans.ts            Free vs Plus entitlements, concierge fee (30% of first-year savings, capped at $20)

apps/api        Node HTTP API (no framework) + JSON-file store
  pipeline.ts     ingest → filter → extract (rules, then LLM if needed) → detect → reconcile → schedule alerts
  llm.ts          Optional Claude extraction step for emails the rules can't fully parse (structured JSON output)
  providers/      Plaid (Link + /transactions/sync), Gmail API, Microsoft Graph, sandbox
  jobs.ts         Alert dispatch every minute, daily re-check, weekly cancel-link checker
  app.ts          REST routes (below)

apps/web        Mobile-first React PWA: onboarding, home, list, item detail, cancel flow, alerts, add sheet, account
```

## PRD coverage

| ID | Requirement | Status |
|---|---|---|
| F1 | Bank/card connection (read-only), recurring detection | ✅ Plaid adapter + sandbox |
| F2 | Gmail/Outlook (read-only, receipts/signups only), trial detection | ✅ Provider-side query filter, rules + LLM extraction |
| F3 | Unified list with amount, cadence, next charge, payment method | ✅ |
| F4 | Push + email alerts at 48h and 24h | ✅ Scheduler + outbox. Delivery is behind a `Notifier` interface (console in MVP; APNs/FCM/email in prod) |
| F5 | Cancel hub: deep link + steps for top services | ✅ 49 catalog merchants seeded, state rights cited |
| F6 | Forwarding address + manual add | ✅ `POST /api/inbound` webhook, paste-an-email, manual form |
| F7 | Savings tracker | ✅ (Plus) |
| F8 | Post-cancel check | ✅ (Plus) |
| F9 | Price-increase alerts (email + charge history) | ✅ (Plus) |
| F10 | Concierge cancellation | ◐ Requests are queued with the fee calculated. The ops tooling to fulfil them is not built |
| F11 | App Store / Google Play | ◐ Detected from bank descriptors and routed to the store's manage page. No direct store import |
| F12–F14 | Trial cards, household, dispute helper | Not started (P2) |

## Privacy principles, as implemented

- **Read-only everywhere.** No code path moves money.
- **Email:** only subjects/senders matching receipt/signup patterns are fetched (`GMAIL_QUERY`, `SUBJECT_PATTERNS`). Bodies are extracted in memory and dropped. Only the extracted fields (`EmailSignal`) are stored. The exact filter is shown to users before they connect.
- **Tokens** are encrypted at rest with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`).
- **One-tap deletion:** `DELETE /api/me` removes the user and all of their data. Disconnecting a bank deletes its transactions.

## Configuration

| Env var | Purpose |
|---|---|
| `PORT` | API port (default 8787) |
| `TOKEN_ENCRYPTION_KEY` | 32-byte hex key for provider tokens. Required in prod; dev uses a random key |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Enable live bank connections (`mode: "live"`) |
| `ANTHROPIC_API_KEY` | Enables the LLM extraction step (model `claude-opus-5-5`, overridable with `TRIALGUARD_LLM_MODEL`) |
| `INBOUND_EMAIL_DOMAIN`, `INBOUND_WEBHOOK_SECRET` | Forwarding addresses `u-<token>@domain` and the inbound webhook secret |
| `NODE_ENV=production` | Disables the dev email-only login |

## API

`POST /api/auth/signup` · `POST /api/auth/login` (dev) · `GET|PATCH|DELETE /api/me`
`POST /api/connections` `{type: bank|gmail|outlook, mode: sandbox|live}` · `DELETE /api/connections/:id` · `GET /api/connections/email-filter` · `POST /api/connections/plaid/link-token` · `POST /api/sync`
`GET|POST /api/items` · `GET|PATCH|DELETE /api/items/:id` (`confirm`, `dismiss`, `restore`, edits)
`GET /api/items/:id/cancel` · `POST /api/items/:id/cancel` `{action: started|completed|undo|concierge}`
`POST /api/forward` (paste email) · `POST /api/inbound` (forwarding webhook) · `GET /api/alerts` · `POST /api/alerts/read` · `GET /api/summary` · `GET /api/merchants?q=` · `POST /api/merchants/:id/report-broken`

## Known gaps before launch

- **OAuth consent flows** for Gmail and Outlook belong in the native app. The API accepts the resulting access token, but there is no token refresh yet. The Gmail restricted scope needs Google verification and a CASA assessment. The PRD puts this on the critical path.
- **Auth** in production should be magic-link or passkeys. The dev build signs in by email only.
- **Storage:** the JSON-file store sits behind a narrow `Store` class. Swap it for Postgres before beta.
- **Billing:** the Plus upgrade is a stub. Use StoreKit / Play Billing.
- **Native app:** the web app is a mobile-first PWA companion. The iOS-first native shell (and real push) is next.
- **Merchant catalog:** 49 of the target 200 merchants are seeded.
