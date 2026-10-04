# Done-for-you cancellation (concierge): ops runbook

F10. A user asks Trialguard to cancel a subscription for them. Staff do it by hand, through the merchant's own channels, under a written authorization the user signed in the app. This page covers how requests reach the team, how to work them, what to record, and who may see what.

Code: `apps/api/src/concierge/` (authorization text, lifecycle, staff identity), routes in `apps/api/src/routes/concierge.ts` (users) and `apps/api/src/routes/admin.ts` (ops), tests in `apps/api/test/concierge.test.ts`.

## How a request is created

1. The cancel guide offers **Cancel it for me**. It appears only for catalog merchants marked `conciergeSupported`, and never for items billed through the App Store or Google Play. Those have to be cancelled in the user's Apple or Google account. For a PayPal-billed item, staff can't touch the user's PayPal: when closing, say in the note that they should also remove the automatic payment in PayPal (the cancel guide shows how).
2. The app shows the authorization text from `GET /api/concierge/authorization-text?merchantId=…`, with the merchant named. The user types their name and ticks **I authorize**.
3. `POST /api/items/:id/concierge` with `{ textVersion, signedName, agree: true }`. The API refuses the request if:
   - the text version isn't the current one (409). The app then reloads the text and asks again.
   - the name is shorter than 2 characters, has no letters, or isn't on one line (400).
   - the item is already cancelled (409).
   - the item already has an open request (409).
4. The request is stored with its authorization:
   - text version
   - SHA-256 of the exact text shown, merchant name filled in
   - merchant name
   - typed name
   - time
   - IP address
   - user agent

   It is written to disk immediately. The fee is computed and stored (see [Fee](#fee)).

The user sees the request on the item page (Queued / In progress / Done / Couldn't complete) and can **withdraw** it while it is open. Withdrawing revokes the authorization.

### The authorization text

- Lives in `apps/api/src/concierge/authorization.ts`. It is marked **DRAFT** (in the text itself, and with `draft: true`) until counsel has reviewed it.
- It is public (`auth: none`), so counsel and App Review can read it without an account.
- **Any wording change must bump `AUTHORIZATION_TEXT_VERSION`.** Requests signed under an older version stay valid for that request. The hash stored with each signature shows exactly which wording was agreed to.
- Once counsel signs off, set `AUTHORIZATION_IS_DRAFT = false`, remove the DRAFT line from the text and bump the version.

## Ops access

- **`ADMIN_TOKEN`** enables the ops API. Unset, every `/api/admin/*` route returns 404. A wrong token gets 401.
  - Use a long random value, at least 32 bytes, e.g. `openssl rand -base64 32`.
  - Keep it in the secrets manager, never in chat or tickets.
  - Rotate it when someone leaves the team.
  - Failed admin-token attempts are not rate-limited by the router today, so the token's length is the protection.
- **`X-Staff-Id`** is required on every ops call. It is your staff handle: 2-64 letters, digits, `.`, `_` or `-`, case-insensitive. It is not an email address. It is recorded as the actor on every audit entry and as the assignee of the requests you claim.
- The handle is a *declared* identity: anyone holding `ADMIN_TOKEN` can send any handle. That is acceptable for a small team sharing one token. Replace it with per-person credentials (SSO) as the team grows. Until then, never act under someone else's handle.

```sh
H=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Staff-Id: sam" -H "Content-Type: application/json")
```

## Working the queue

| Step | Call |
|---|---|
| See the queue (oldest first) | `curl -s "${H[@]}" "$PUBLIC_URL/api/admin/concierge?status=queued"` |
| Claim one | `curl -s "${H[@]}" -X POST "$PUBLIC_URL/api/admin/concierge/<id>/claim" -d '{}'` |
| Re-open the full request | `curl -s "${H[@]}" "$PUBLIC_URL/api/admin/concierge/<id>"` |
| Mark done | `curl -s "${H[@]}" -X POST "$PUBLIC_URL/api/admin/concierge/<id>/status" -d '{"status":"done","proof":"Netflix confirmation CXL-48213","note":"Cancelled by chat. Access ends Oct 20."}'` |
| Mark failed | `curl -s "${H[@]}" -X POST "$PUBLIC_URL/api/admin/concierge/<id>/status" -d '{"status":"failed","note":"Netflix needs you to sign in yourself to cancel. The guide in the app shows how."}'` |
| Your work in progress | `…/api/admin/concierge?status=in_progress` |
| Finished requests (newest first) | `…/api/admin/concierge?status=done` or `?status=failed` |

`?limit=` caps the list (default 100, max 200).

### Step by step

1. **Pick the oldest queued request** whose merchant you can handle. Queue rows show the merchant and cancel URL, the item name and price, the fee, and whether a valid authorization is on file.
2. **Claim it.** You become the assignee and it moves to `in_progress`.
   - A request someone else has claimed is refused (409). Ask them; don't work around it.
   - A request without a written authorization (queued before this feature existed) can't be claimed. The user has to withdraw it and request again.
3. **Read the claim response.** It has what you need to do the job:
   - the merchant's cancel steps and phone number
   - the item's billing facts: price, cadence, rail, next charge or trial end, payment method label such as "Visa ••4242"
   - the authorization as signed: name, time, version, text hash
   - the user's email, so the merchant can find the account
4. **Re-check the status right before you contact the merchant.** The user can withdraw at any time. A withdrawn request shows as `cancelled` and you must stop.
5. **Cancel through the merchant's own channels:** the account page, support chat, email or phone. If the merchant asks, say you act for the customer under a written authorization, and give the name they signed and the date. Decline every retention offer, discount, pause or downgrade. The authorization covers cancelling and asking for a refund, nothing else.
6. **Ask for a refund** when one may be owed, such as a charge just after a trial ended, or a charge after an earlier cancellation. Refunds go back to the customer's original payment method through the merchant. Trialguard never receives them.
7. **Close it:**
   - `done` needs **proof**: the merchant's confirmation number, or a reference to the confirmation email or chat transcript. The item is then marked cancelled (`cancel_pending`) with that proof, exactly as if the user had tapped "I've cancelled it". The normal statement check then verifies it, or flags a charge after cancel.
   - `failed` needs a **note**. The user reads it, so write it for them: what happened and what they can do next.
   - `note` on `done` is optional and is also shown to the user.

Only the assignee can close a request. Nothing moves out of `done`, `failed` or `cancelled`.

### State machine

| From | To | Who |
|---|---|---|
| `queued` | `in_progress` | staff (claim) |
| `in_progress` | `done` / `failed` | the assigned staff member |
| `queued` / `in_progress` | `cancelled` | the user (withdraw); revokes the authorization |

Any other move is refused with 409. If a request's assignee is unavailable, there is no API to release or reassign it yet. An engineer has to edit the record, and should note why in the audit trail.

## What proof to capture

- **Always:**
  - the merchant's confirmation number or cancellation reference
  - the date and channel (web, chat, email, phone)
  - the end of access if the merchant states it
- **Chat or email:** keep the transcript or the confirmation email in the team's evidence store, under the request id.
- **Phone:** the agent's first name or ID, the call time, and any reference number.
- **Refund requested:** what was asked for (amount, which charge) and what the merchant said.
- The `proof` field holds a short reference (200 characters). Don't paste transcripts, card numbers or the customer's personal details into `proof` or `note`. Both are shown to the user, and `proof` is stored on the item.

## Data access rules

- **The ops API never returns** bank transactions, provider tokens, session tokens, or the forwarding address. Tests enforce this.
- **The queue list** shows no personal details: no name, no email.
- **The detail view** (`GET /api/admin/concierge/:id`, and the claim and status responses) shows:
  - the signed name
  - the authorization's version and hash
  - the user's id
- **The user's email** is shown only to the assignee, and only while the request is `in_progress`.
- **IP address and user agent** are evidence only. They are never shown to staff, and are kept on the record for disputes.
- **Every look at a request is audited:**
  - each detail view writes `concierge.viewed`
  - a claim writes `concierge.claimed`
  - reading the audit trail writes `audit.viewed`
- **Use the data only to cancel this one subscription with this one merchant.** Don't use it to contact the user about anything else, and don't copy it into personal notes or tools.
- **If a merchant needs the account password** to cancel, mark the request failed with a note telling the user how to do it themselves. We don't collect merchant passwords, and staff must never ask a user for one by email, chat or phone.

## Audit trail

Every concierge action is an append-only audit entry with:

- `actor`: `{ type: 'user' | 'staff', id }`
- `action`
- `subject`: `{ type: 'concierge_request', id }`
- `userId`
- non-sensitive `details`: statuses, versions, ids and flags. Never names, notes, proof, IP or user agent.

| Action | Actor | Details |
|---|---|---|
| `concierge.requested` | user | item, merchant, fee, text version and hash |
| `concierge.withdrawn` | user | previous status, authorization revoked |
| `concierge.claimed` | staff | `queued -> in_progress` |
| `concierge.status_changed` | staff | from/to, whether proof and a note were given, whether the item was marked cancelled |
| `concierge.viewed` | staff | status at the time |
| `audit.viewed` | staff | filter and count |

Read it with `GET /api/admin/audit?userId=<usr_…>&limit=100`, or `?subjectId=<cnc_…>` for one request's trail. Results are newest first; `limit` defaults to 100, max 500.

## Retention of authorizations

- **Today:**
  - A request and its authorization (typed name, time, IP, user agent, text version and hash) are kept for as long as the user's account exists.
  - Withdrawing marks the authorization revoked but keeps the record. It is the evidence that consent existed, and when it ended.
  - Deleting the account (`DELETE /api/me`) removes the user's requests and their audit entries. Only the `account.deleted` entry remains.
- **Open question for counsel:** should authorizations and the concierge audit trail outlive account deletion for a limited period, as evidence if a merchant or the user disputes what staff did? If so, for how long, and on what legal basis? If the answer is yes, `Store.deleteUser` needs to change to keep them, minimized, for that period.
- **Evidence kept outside the app** (transcripts, emails) follows the same rule. Delete it with the account unless counsel decides otherwise.
- **In production** (Postgres), make the audit table insert-only for the application role, so "append-only" is enforced rather than conventional.

## Fee

- `feeCents` is computed when the request is made: 30% of the first-year savings, capped at $20 (`conciergeFeeCents` in `packages/core/src/plans.ts`).
- It is shown to the user before they submit, as the rule, and on the request afterwards, as the amount.
- **Nothing charges it.** No payment is taken and none is implemented.

Open questions before any charging is built:

- **Apple (counsel / App Review):** Can this fee be charged outside Apple in-app purchase, given that a person performs the service outside the app? App Store Review Guideline 3.1.3(e), "Goods and Services Outside of the App", is likely relevant. What do counsel and App Review conclude, and does the answer change if the request is made in the iOS app rather than on the web?
- **Google Play:** The equivalent question under Google Play's payments policy.
- **Timing:** When is the fee due (on success only?), what is the refund policy if the merchant later charges again, and how is it disclosed in the terms of service?

## Other open questions (counsel)

- Review the authorization wording, especially:
  - the scope (sign in or contact, cancel, ask for a refund)
  - the "will not do" list
  - how revocation works
  - the records statement
- Whether staff may ever sign in to a user's merchant account, and if so how access would be given safely. The text permits it; ops does not do it today (see Data access rules).
- Whether acting for users with merchants needs any registration, licensing or specific disclosures in the states where we operate.
