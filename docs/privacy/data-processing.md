# Data processing

> **DRAFT for counsel review.** This is engineering's description of what the code does. It is not a privacy policy and not legal advice. Statements about third parties' own practices are deliberately left out where we haven't confirmed them; they are listed as **questions to confirm** at the end.

The in-app copy comes from the same facts. `GET /api/privacy` and `GET /api/connections/email-filter` generate it from the server's configuration (`apps/api/src/routes/privacy.ts`). If this document and the code disagree, the code is right and this document needs fixing.

## What Trialguard holds

Every item below is included in the user's data export (`GET /api/me/export`) and removed by account deletion (`DELETE /api/me`).

| Data | Source | Kept in (`apps/api/src/store.ts`) |
|---|---|---|
| Email address, US state, plan, alert settings (channels, quiet hours, time zone) | The user | `users` |
| Bank and inbox connections: type, label, status, encrypted access token | The user, Plaid, Google, Microsoft | `connections` |
| Bank transactions: date, amount, merchant description, card or account label | Plaid | `transactions` |
| Fields extracted from emails: service, price, billing period, trial length, charge and price-change dates, sender domain | Connected inbox, forwarded or pasted emails | `signals` |
| Subscriptions and trials found, with their history | Derived from the rows above | `items` |
| Alerts: title, text, schedule, delivery status | Derived | `alerts` |
| Devices: platform, app version, push token | The app | `devices` |
| Trialguard Plus purchase records | App Store / Google Play | `billing` |
| Concierge cancellation requests, including the signed authorization (name, time, IP, browser) | The user | `concierge` |
| Broken cancel-link reports | The user | `brokenLinks` |
| Audit log of sensitive actions (export, deletion, billing changes, unsubscribes) | The system | `audit` |

**Email text is never stored.** It is held in memory while the fields are extracted, then dropped.

The export leaves out, or shortens to the last 4 characters, values that work as credentials: the session token, encrypted provider tokens, push tokens, store purchase tokens. It also leaves out internal bookkeeping: Plaid sync cursors, the worker that sent an alert, provider error text, and the staff member assigned to a concierge request. Each stored type has a total field policy in `routes/privacy.ts`, so a new stored field fails to compile until someone decides how it is exported.

## How email is handled

1. **Filter at the provider.** Gmail is queried with a subject filter (`GMAIL_QUERY` in `packages/core/src/email.ts`). Outlook uses a Graph `$search` with similar terms. Unrelated mail is never downloaded. Before connecting, users can see the filter ("See exactly which emails we read").
2. **Rules first.** Pattern-based extraction runs on the server (`extractEmailSignal`).
3. **AI extraction, only when the rules can't fill the fields an alert needs.** This step runs only when Anthropic credentials are configured (`config.llmEnabled`). The email's sender, subject, received date and text (capped at 30,000 characters) go to Anthropic's Messages API. Claude returns structured fields.
4. **Only the extracted fields are stored** (`signals`).

The same pipeline handles emails the user forwards to their personal address or pastes into the app.

### Safeguards on the AI step (`apps/api/src/llm.ts`)

- Email content is treated as hostile input. The model gets no tools. The email sits inside delimiter tags that the email itself cannot close, and the system prompt tells the model to treat it as data.
- The output is bounds-checked beyond the schema: prices above $0 and up to $5,000; trial lengths of 1–366 days; real calendar dates from 31 days before to 400 days after the email; service names of 60 characters or fewer, with no links, addresses, markup or invisible characters. A failing field is dropped. An unknown kind drops the whole result.
- The model's word alone never triggers an action. A cancellation counts only if the rules also read the email as one. A result the rules don't corroborate (same kind, same merchant) is marked for the user to review.
- Cancellation emails for catalog merchants count only when sent from that merchant's domain. Forwarded and pasted emails are the user's own statement and are trusted (`packages/core/src/reconcile.ts`).
- Logs never contain email content. Failures log only the error type and HTTP status.

## Processors and data sources

| Service | Role | Receives from Trialguard (or from the user on Trialguard's behalf) | When | Configured by |
|---|---|---|---|---|
| **Plaid** | Read-only bank connection | The user's bank sign-in, entered in Plaid Link (Trialguard never sees it); Trialguard's internal user id as `client_user_id`. Returns transactions. | User connects a bank | `PLAID_CLIENT_ID`, `PLAID_SECRET` |
| **Google (Gmail API)** | Source of email, `gmail.readonly` | Search requests with the filter query, sent with the user's OAuth token. Returns matching messages. | User connects Gmail | Client-side OAuth |
| **Microsoft (Microsoft Graph)** | Source of email, `Mail.Read` | Search requests, sent with the user's OAuth token. Returns matching messages. | User connects Outlook | Client-side OAuth |
| **Anthropic** | AI extraction | Sender, subject, received date and text (capped at 30,000 characters) of filtered emails the rules can't fully parse | Only when `ANTHROPIC_API_KEY` is set and `TRIALGUARD_DISABLE_LLM` is not `1` | `ANTHROPIC_API_KEY`, `TRIALGUARD_LLM_MODEL` |
| **Apple Push Notification service** | iOS push alerts | Device push token; alert title and text (service, amount, date) | Push on, iOS device | `APNS_*` |
| **Firebase Cloud Messaging (Google)** | Android/web push alerts | Device registration token; alert title and text | Push on, Android or web device | `FCM_SERVICE_ACCOUNT_PATH` |
| **Postmark** | Alert email | User's email address; alert subject and text; unsubscribe link | Email alerts on | `POSTMARK_SERVER_TOKEN` |
| **Inbound email provider** (vendor not chosen yet) | Receives mail sent to `u-<token>@<INBOUND_EMAIL_DOMAIN>` | The full forwarded email | User forwards an email | `INBOUND_EMAIL_DOMAIN`, `INBOUND_WEBHOOK_SECRET` |
| **Apple App Store / Google Play** | Plus billing | A random account token (`appAccountToken` / `obfuscatedExternalAccountId`) to link the purchase. Returns purchase status. | User buys Plus | `apps/api/src/billing` |

## Retention

| Data | Kept |
|---|---|
| Email text | Not stored. Held in memory during extraction only. |
| Extracted email fields | Until account deletion. Disconnecting an inbox does not delete them today. **Confirm** whether it should. |
| Bank transactions | Until that bank is disconnected or the account is deleted. |
| Items, alerts, devices, purchase records, concierge requests, broken-link reports | Until account deletion. |
| Audit log | Deleted with the account, except the `account.deleted` record. |
| Server logs | Built to exclude email content, addresses and tokens (`apps/api/src/log.ts`). The retention period depends on the hosting setup and is not set yet. |
| Backups | Not set up yet (JSON-file store). Define a retention period, and how deletions reach backups, before moving to Postgres. |

## User rights in the product

- **Access:** Account → Privacy → *Download my data* (`GET /api/me/export`). It returns a JSON file, is limited to 5 per hour, and is recorded in the audit log as `data.exported`.
- **Deletion:** Account → Privacy → *Delete my account and data* (`DELETE /api/me`).
- **Disconnect:** removing a bank deletes its transactions. Removing an inbox stops reading it.
- **Email alerts:** one-click unsubscribe in every alert email.

## Draft: Google API Services User Data Policy, Limited Use disclosure

> **DRAFT, for counsel review.** Before publishing, check the exact wording Google currently requires on its policy page. Items in [brackets] are unconfirmed.

> Trialguard's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.
>
> When you connect Gmail, Trialguard asks for read-only access. It retrieves only messages whose subject matches its receipt and signup filter, which you can review in the app before connecting. Trialguard uses these messages only to find your subscriptions, free trials, renewals, price changes and cancellations, and to alert you about them. When Trialguard's own rules cannot fully read a message, the message's sender, subject and text are sent to our AI service provider, Anthropic, only to extract the service name, price and dates for you. Trialguard stores the extracted details, not your messages. Trialguard does not sell Gmail data, does not use it for advertising, and does not use it to train generalized AI or machine-learning models. [Anthropic's use of the data: confirm under our agreement with Anthropic before stating anything about it.] People at Trialguard do not read your messages [confirm: except with your consent for specific messages, for security purposes, or to comply with law].

## Questions to confirm

**Anthropic**
- How long are API inputs and outputs retained, and under what terms? Is zero data retention available to us, and should we arrange it? Don't claim zero retention until it is in place.
- Are API inputs excluded from model training under our commercial terms? Get this in writing (DPA or terms) before saying so to users.
- Is a data processing agreement in place? Does it name Anthropic as a service provider or processor (CCPA, state laws)? Which sub-processors does it list?
- Where is the data processed? Do we need to pin the processing region?

**Google (Limited Use and CASA)**
- Does sending Gmail message text to Anthropic for per-message extraction count as a permitted transfer "to provide or improve user-facing features"? Does it meet Google's current requirements on using Workspace data with AI models?
- Does the consent screen, the in-app disclosure (shown before connecting, see `apps/web/src/screens/Connect.tsx`) and the privacy policy together meet the "prominent disclosure" expectations of the verification review?
- `docs/LAUNCH.md` plans to collect anonymized emails from consenting beta users for evaluation. Confirm how that fits within Limited Use, or limit it to forwarded and pasted emails.

**Microsoft**
- Do Microsoft's publisher terms add any disclosure requirements for sending Outlook mail content to a third-party AI provider?

**Plaid**
- Does the privacy policy need specific Plaid language (Plaid's end-user privacy policy link, and their role in collecting bank credentials)?

**Delivery and inbound providers**
- How long does Postmark retain message content, and can it be shortened? Alert emails contain service names and amounts.
- Which inbound email provider will we use? How long does it keep raw messages, and can storage be turned off?

**Trialguard**
- Which state privacy laws apply at launch? What verification and response deadlines do access and deletion requests need? `GET /api/me/export` covers the data; the process around it isn't defined yet.
- Is "We don't sell your data" the right wording under each applicable law's definition of "sell" and "share"? The app currently says only "We don't sell your data".
- Should disconnecting an inbox also delete the fields extracted from it?
- What retention period should apply to logs and to backups?
