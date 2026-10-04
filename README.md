# Trialguard

**Never pay for a trial you forgot.** Trialguard finds every recurring charge and free trial a person has, warns them 48h and 24h before a trial converts or a renewal charges, and helps them cancel. A cancellation counts as done only after the next statement shows no charge.

This repo is the MVP from the PRD (the P0 features plus price-hike alerts and the post-cancel check), hardened for launch: verified provider webhooks, send-once alert delivery, store billing, data export, an audited concierge flow, accuracy evals and CI. What's left before launch that isn't code is in [docs/LAUNCH.md](docs/LAUNCH.md).

## Quick start

```bash
npm ci
npm run dev          # API on :8787 + web app on :5173 (open http://localhost:5173)
npm test             # core engine + API tests
npm run lint
npm run typecheck    # API/core and web
npm run eval         # accuracy evals (rules-only, offline); fails on regressions
```

Production-style single server: `npm start` builds the web app and serves it from the API on `:8787`.

Bank and inbox connections default to **sandbox mode**. The sandbox generates realistic data relative to today: Netflix with a price hike, Spotify billed through PayPal, two App Store subscriptions, an unknown gym, a lapsed Hulu, coffee and grocery noise, and four trial signup emails. You can run the whole flow without real accounts.

Requires **Node ≥ 22.18** (pinned in `.nvmrc`, `engines` and `engine-strict`). The API and core run TypeScript directly through Node's type stripping, so they have no build step. The server also refuses to boot on an older Node.

## Layout

```
packages/core     Pure detection engine (no I/O), unit-tested
  merchants.ts      Merchant catalog: descriptor patterns, email domains, cancel URL + steps (seed of the top 200)
  normalize.ts      "NFLX*Netflix 866-579 CA" → Netflix; sees through PayPal / App Store / Google Play
  recurring.ts  F1  recurring-charge detection by merchant, amount and cadence; price history
  email.ts      F2  which emails we read + rules-based extraction; sender domain for spoof checks
  reconcile.ts      one item per subscription across its life (trial → paid → cancel pending → verified / charged after cancel);
                    cancellations only trusted from the merchant's own domain or the user themselves
  tz.ts, alerts.ts F4  48h/24h alerts in the user's time zone (DST-safe), quiet hours, per-type switches, stable event ids
  cancel.ts     F5  cancel plan: deep link, steps, billing-rail routing, state auto-renewal rights (pending counsel review)
  savings.ts    F7  monthly/yearly totals, saved so far, verified savings
  plans.ts          Free vs Plus entitlements, concierge fee (30% of first-year savings, capped at $20)

apps/api          Node HTTP API (no framework), zod validation, JSON-file store
  http.ts           router: typed params, schema-validated bodies, auth modes, rate limits, request ids, metrics
  routes/           one module per area (auth, account, notifications, privacy, connections, plaid, items, cancel,
                    concierge, forward, alerts, billing, admin, health)
  pipeline.ts       ingest → filter → extract (rules, then LLM if needed) → detect → reconcile → schedule alerts
  llm.ts            optional Claude extraction for emails the rules can't fully parse; untrusted-input hardened
  delivery/         send-once outbox (claim + lease), job-leader lock, APNs, FCM, Postmark email, unsubscribe
  billing/          App Store Server Notifications V2 (x5c chain + JWS), Google Play RTDN (OIDC + subscriptionsv2), entitlements
  plaid/            Plaid webhook verification (ES256 JWT + body hash) and Item status handling
  concierge/        written authorization, staff queue state machine, audit trail
  keyring.ts        versioned AES-256-GCM token encryption with key ids and rotation
  log.ts, metrics.ts  JSON logs with PII redaction, error-reporting hook, Prometheus metrics

apps/web          Mobile-first React PWA: onboarding, home, list, item detail, cancel flow + concierge, alerts, account
evals/            Labeled synthetic datasets + precision/recall harness; optional LLM model comparison
docs/             LAUNCH.md (launch checklist), privacy/data-processing.md, concierge.md (ops runbook)
```

## PRD coverage

| ID | Requirement | Status |
|---|---|---|
| F1 | Bank/card connection (read-only), recurring detection | ✅ Plaid (Link, `/transactions/sync`, verified webhooks, update mode) + sandbox |
| F2 | Gmail / Outlook (read-only, receipts and signups only), trial detection | ✅ Provider-side query filter, rules + hardened LLM extraction |
| F3 | Unified list with amount, cadence, next charge, payment method | ✅ |
| F4 | Push + email alerts at 48h and 24h | ✅ Time-zone correct, quiet hours, send-once outbox, APNs / FCM / Postmark |
| F5 | Cancel hub: deep link + steps | ✅ 49 catalog merchants seeded, state rights shown (marked pending counsel review) |
| F6 | Forwarding address + manual add | ✅ Inbound webhook, paste-an-email, manual form |
| F7 | Savings tracker | ✅ (Plus) |
| F8 | Post-cancel check | ✅ (Plus) |
| F9 | Price-increase alerts (email + charge history) | ✅ (Plus) |
| F10 | Concierge cancellation | ◐ Written authorization, ops queue, audit trail. Fee isn't charged yet (open App Store question) |
| F11 | App Store / Google Play | ◐ Detected from bank descriptors and routed to the store's manage page. No direct store import |
| F12–F14 | Trial cards, household, dispute helper | Not started (P2) |

Plus is a real store subscription: entitlements come only from verified App Store / Google Play notifications, with a daily expiry sweep as a backstop.

## Security and privacy, as implemented

- **Read-only everywhere.** No code path moves money.
- **Every request body is schema-validated** (zod, strict objects). A test fails if a new mutating route skips validation. Unknown fields are rejected.
- **Rate limits:**
  - sign-in and unauthenticated attempts, including wrong admin tokens
  - paste/manual ingest, sync and data export
  - the inbound-mail webhook (per forwarding address)
  - provider webhooks
- **Webhooks are verified before they're trusted:**
  - App Store: JWS with the x5c chain pinned to Apple's root, plus Apple's marker OIDs
  - Google Pub/Sub: OIDC JWT checked against Google's JWKS
  - Plaid: ES256 JWT, the SHA-256 of the exact body, and a 5-minute freshness window
  - inbound mail: shared secret
  - All are deduplicated by event id.
- **Email.**
  - Only subjects and senders matching receipt and signup patterns are fetched.
  - When the rules can't fully parse an email and LLM extraction is enabled, the email text is sent to Anthropic for extraction. Only the extracted fields are stored, never the email.
  - The in-app copy states exactly what this server does (`GET /api/privacy`).
- **LLM output is untrusted.**
  - The model has no tools, delimiters are neutralized, and every field is bounds-checked.
  - LLM-only results are capped below the review threshold.
  - An LLM-only "cancelled" is ignored.
- **Spoofed cancellations are ignored.** A "you've been cancelled" email only counts when it comes from the merchant's own domain in the user's connected inbox, or when the user pastes it in the app. Mail sent to a forwarding address can add trials and receipts, but never cancels anything: anyone can send it with any From line.
- **Provider tokens** are encrypted with versioned keys (`v2.<kid>…`, key id bound as AAD). The keyring is loaded from a mounted secrets file. Rotate with `node apps/api/scripts/rotate-tokens.ts`.
- **Logs** are JSON with personal data redacted (emails, tokens, card and account digits, names, notes). Metrics are at `/metrics`.
- **Your data:**
  - `GET /api/me/export` returns a complete JSON copy; secrets are omitted and identifiers masked.
  - `DELETE /api/me` deletes everything.
  - Disconnecting a bank also revokes the Plaid item.
- **Concierge.** Staff act only with the user's signed, versioned, revocable authorization. Every staff action and view is in an append-only audit trail.

## Configuration

Anything not set falls back to dev-friendly defaults. In production the server refuses to boot without its core secrets, and it fails on any half-configured provider.

| Area | Env vars |
|---|---|
| Server | `PORT`, `PUBLIC_URL` (https in prod), `TRUST_PROXY_HOPS` = number of proxies in front that append `X-Forwarded-For` (`TRUST_PROXY=1` means one), `LOG_LEVEL`, `NODE_ENV=production` |
| Storage | `TRIALGUARD_DATA_FILE`, `TRIALGUARD_JOB_LOCK_FILE` |
| Token encryption | `TOKEN_KEYRING_FILE` (preferred), or `TOKEN_ENCRYPTION_KEYS="kid:hex,…"` (first is active), or legacy `TOKEN_ENCRYPTION_KEY` |
| Secrets | `LINK_SIGNING_SECRET` (unsubscribe links), `INBOUND_WEBHOOK_SECRET`, `ADMIN_TOKEN` (ops API), `METRICS_TOKEN` |
| Plaid | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_WEBHOOK_URL` |
| LLM extraction | `ANTHROPIC_API_KEY` (model `claude-opus-5-5`; override with `TRIALGUARD_LLM_MODEL`), `TRIALGUARD_DISABLE_LLM=1` |
| Push | `APNS_KEY_PATH` or `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION`; `FCM_SERVICE_ACCOUNT_PATH` |
| Email | `POSTMARK_SERVER_TOKEN`, `POSTMARK_MESSAGE_STREAM`, `EMAIL_FROM`, `COMPANY_POSTAL_ADDRESS` |
| App Store | `APPLE_BUNDLE_ID`, `APPLE_ROOT_CA_PATH`, `APPLE_ENVIRONMENTS` |
| Google Play | `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_PATH`, `GOOGLE_PUBSUB_AUDIENCE`, `GOOGLE_PUBSUB_SERVICE_ACCOUNT` |
| Forwarding | `INBOUND_EMAIL_DOMAIN` |
| Jobs | `TRIALGUARD_JOBS=0` disables background jobs (tests) |

## API

**Health**
- `GET /healthz` (liveness)
- `GET /readyz` (readiness)
- `GET /metrics` (Prometheus)
- `GET /api/health`

**Account**
- `POST /api/auth/signup`
- `POST /api/auth/login` (dev)
- `POST /api/auth/email/send-code`
- `POST /api/auth/email/verify` (until verified: no alert emails, and the address isn't reserved)
- `GET|PATCH|DELETE /api/me`
- `GET /api/me/export`
- `GET|PUT /api/me/notifications`
- `GET /api/privacy`

**Devices and email**
- `GET|POST /api/devices`
- `DELETE /api/devices/:id`
- `GET|POST /api/unsubscribe?token=` (RFC 8058 one-click)

**Connections**
- `POST /api/connections`
- `DELETE /api/connections/:id`
- `POST /api/connections/:id/link-token` (Plaid update mode)
- `POST /api/connections/:id/relinked`
- `POST /api/connections/plaid/link-token`
- `GET /api/connections/email-filter`
- `POST /api/sync`

**Items and cancelling**
- `GET|POST /api/items`
- `GET|PATCH|DELETE /api/items/:id`
- `GET|POST /api/items/:id/cancel`
- `POST /api/merchants/:id/report-broken`
- `GET /api/merchants`

**Concierge**
- `GET /api/concierge/authorization-text`
- `POST /api/items/:id/concierge` (signed authorization)
- `GET /api/concierge`
- `POST /api/concierge/:id/withdraw`

**Ingest**
- `POST /api/forward` (paste)
- `POST /api/inbound` (forwarding-address webhook)

**Alerts and summary**
- `GET /api/alerts`
- `POST /api/alerts/read`
- `GET /api/summary`

**Billing**
- `GET /api/billing/status`
- `POST /api/billing/apple/notifications`
- `POST /api/billing/apple/verify`
- `POST /api/billing/google/rtdn`

**Plaid**
- `POST /api/webhooks/plaid`

**Ops** (`ADMIN_TOKEN` + `X-Staff-Id`)
- `GET /api/admin/concierge`
- `GET /api/admin/concierge/:id`
- `POST /api/admin/concierge/:id/claim`
- `POST /api/admin/concierge/:id/status`
- `GET /api/admin/audit`

## Testing and CI

GitHub Actions runs on every pull request, on Node 22.18.0 (the minimum) and Node 24:
- lint (ESLint with type-aware rules)
- typecheck (API/core and web)
- unit and API tests
- eval unit tests
- the accuracy gate (`npm run eval`)
- the web build

**Accuracy baseline** (rules-only, synthetic data, `evals/baseline.json`):

| Task | Results |
|---|---|
| Recurring detection | precision 0.75, recall 0.86 |
| Trial emails | precision 0.91, recall 0.97 |
| End to end | 6 of 8 scenarios |

The harness lists the specific misses (unsupported cadences, DD/MM dates, shared sender domains, marketing "start your free trial" emails, and more). They're the next accuracy work. Add real, anonymized samples per `evals/README.md` before beta.

## Known gaps before launch

- **Third-party reviews** (Google CASA, Microsoft publisher verification, Plaid production) and **legal review** (privacy policy, Limited Use, Safeguards Rule, state rights, concierge authorization and fee) are tracked in [docs/LAUNCH.md](docs/LAUNCH.md).
- **Native app.** OAuth consent for Gmail/Outlook, Plaid Link, StoreKit / Play Billing and push registration belong in the native app. The API side of each is built. There is no Gmail/Outlook token refresh yet.
- **Auth** in production should be magic-link or passkeys. The dev build signs in by email only.
- **Storage** is a JSON file behind a narrow `Store` class, so it's one instance at a time. Move to Postgres before beta: unique index on alert ids, `FOR UPDATE SKIP LOCKED` claims, and shared rate-limit buckets.
- **Merchant catalog** has 49 of the target 200.
