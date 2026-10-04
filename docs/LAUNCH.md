# Launch checklist

What has to be true before public launch, beyond the code. Each item says who owns it and where the code side lives.
Status markers: **[code]** done in this repo · **[ops]** a setup task · **[external]** a third-party review with a lead time · **[counsel]** needs a lawyer.

Start the **[external]** items first. Each one has a queue the team doesn't control.

## Third-party reviews (long lead times, start now)

| Item | Why it blocks launch | Notes |
|---|---|---|
| **Google OAuth verification + CASA assessment** [external] | `gmail.readonly` is a restricted scope. Until the app is verified and has passed a Cloud Application Security Assessment, consent is limited to test users. | Needs a published privacy policy that includes the Limited Use disclosure (draft in `docs/privacy/data-processing.md`), a homepage, a demo video of the OAuth flow, and an authorized assessor for CASA. Plan for re-assessment every year. |
| **Microsoft publisher verification** [external] | Without it, Outlook users see an "unverified" consent screen, and many organizations block consent to unverified multi-tenant apps. | Needs a Microsoft AI Cloud Partner Program (formerly MPN) account and a verified publisher domain matching the app registration. `Mail.Read` (delegated) is the only mail scope requested. |
| **Plaid production access** [external] | Sandbox and limited development access aren't enough for real users. | Request in the Plaid Dashboard: company and use-case profile, security questionnaire, application display info. Some large banks need extra OAuth registration on top of production approval, so budget extra time for those. See the notes at the top of `apps/api/src/plaid/webhooks.ts`. |
| **Apple / Google store review of the subscription** [external] | Plus is an auto-renewing in-app subscription. | Server notifications are implemented (`apps/api/src/billing`). Configure the App Store Server Notifications V2 URL and the Play RTDN Pub/Sub topic and push subscription. |

## Privacy and legal [counsel]

- **Privacy policy and terms of service.** They must describe exactly what the code does:
  - emails matching the receipt/signup filter are read
  - for emails the rules can't fully parse, the email text is sent to Anthropic for extraction
  - only extracted fields are kept
  - bank data comes through Plaid, read-only
  - data is never sold or shared

  The processor list is in `docs/privacy/data-processing.md`.
- **Google Limited Use.** The privacy policy needs the Limited Use statement, and the use of Gmail data, including sending it to an AI provider, must stay within the Google API Services User Data Policy. Confirm with counsel that this LLM use is permitted and correctly disclosed.
- **Right to access / deletion.** `GET /api/me/export` and `DELETE /api/me` exist [code]. Confirm which state privacy laws apply at launch (CCPA thresholds and others) and what response timelines and verification steps are required.
- **FTC Safeguards Rule (16 CFR Part 314).** Ask counsel whether Trialguard is a "financial institution" under GLBA, since it handles bank transaction data. If it is, it needs a written information security program, a qualified individual, risk assessments, MFA for staff, encryption, monitoring, and incident response (including FTC notification for qualifying breaches).
- **Cancellation-rights content.** `packages/core/src/cancel.ts` covers CA, NY, CO, VT, VA and ROSCA, and is marked as not yet reviewed (`rightsNeedCounselReview`). Counsel should review it, extend it to the other states with auto-renewal laws, and set `RIGHTS_LAST_REVIEWED`. These laws change, so re-review on a schedule.
- **Concierge.**
  - Counsel to review the written authorization text (`GET /api/concierge/authorization-text`).
  - Ask whether the concierge fee may be charged outside Apple in-app purchase, given a person performs the service. App Store Review Guideline 3.1.3(e) is likely relevant.
  - See `docs/concierge.md`.

## Email deliverability [ops]

- Set up a transactional sender (Postmark is implemented) on a dedicated subdomain (e.g. `alerts.trialguard.app`).
- Publish **SPF** and **DKIM** records for that domain, then **DMARC**: start at `p=none` with reporting, and move to `quarantine`/`reject` once reports are clean.
- Every alert email carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), an unsubscribe link and the company postal address (CAN-SPAM) [code]. Gmail and Yahoo require one-click unsubscribe and DMARC from bulk senders.
- Set `COMPANY_POSTAL_ADDRESS`, `EMAIL_FROM`, `POSTMARK_SERVER_TOKEN`, `PUBLIC_URL`, `LINK_SIGNING_SECRET`.

## Push [ops]

- **APNs:** create an auth key (.p8) and set `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION=1`.
- **FCM:** create a service account with the messaging scope and set `FCM_SERVICE_ACCOUNT_PATH`.
- The app registers its token with `POST /api/devices` on every launch.

## Infrastructure [ops]

- **Database.** Move the JSON store to Postgres before beta:
  - unique index on `alerts.id` (the send-once key)
  - claim alerts with `SELECT … FOR UPDATE SKIP LOCKED`
  - unique `(provider, id)` on webhook events
  - encrypted storage and backups
- **Keys.**
  - Mount the token keyring from a secrets manager or KMS (`TOKEN_KEYRING_FILE`), not env vars.
  - Rotation: add the new key first in the keyring, deploy, run `node apps/api/scripts/rotate-tokens.ts`, then remove the old key.
- **Secrets that must be set in production:** `INBOUND_WEBHOOK_SECRET`, `LINK_SIGNING_SECRET`, `PUBLIC_URL`, `ADMIN_TOKEN`, `METRICS_TOKEN`, plus provider credentials. The server refuses to boot without the core ones.
- **Health checks:**
  - liveness: `GET /healthz`
  - readiness: `GET /readyz`
  - metrics: `GET /metrics` (Prometheus, bearer `METRICS_TOKEN`)
- **Error tracking.** Wire `setErrorReporter` (apps/api/src/log.ts) to Sentry or similar.
- **Alerting on metrics:**
  - `sync_connection_errors_total` rate
  - `alerts_delivered_total{result="failed"}`
  - outbox backlog
  - `rate_limited_total` spikes
- **Rate limits** are per instance and in memory. With more than one instance, move the buckets to Redis.
- **Pen test** before launch (PRD risk table).

## Accuracy [code + ops]

- Run `npm run eval` (rules-only, no API cost) in CI. It fails on regressions against `evals/baseline.json`.
- Before beta, add real samples:
  - collect anonymized transactions and emails from consenting beta users, following `evals/README.md`
  - re-baseline
  - track the PRD gate: 80% of trials detected correctly
- **Model choice.** Extraction uses `claude-opus-5-5` by default. Compare cheaper models on the same eval set with `node evals/run.ts --llm --model <id> --yes` before switching (`TRIALGUARD_LLM_MODEL`).
