# Accuracy evals

These evals answer one question: **did a change make detection or extraction better or worse?** They score the
real engine (`packages/core`) and, optionally, the Claude extraction step (`apps/api/src/llm.ts`) against labeled
cases. Running them makes no network calls unless you ask for the LLM comparison and confirm it.

```bash
npm run eval                        # rules-only evals + baseline gate (exit 1 on a regression)
npm run eval -- --update-baseline   # re-record evals/baseline.json after an intended change
npm run eval -- --quiet             # tables only, no per-case failure lists
node --test evals/*.test.ts         # unit tests for the metrics and the harness itself
```

Each run prints a table per task and writes a JSON report (every metric, failure and prediction) to
`evals/results/<timestamp>.json` and `evals/results/latest.json`. Reports are git-ignored.

## What is measured

| Task | Cases | What runs | Headline metrics |
|---|---|---|---|
| Recurring-charge detection | 48 synthetic bank histories (+ samples) | `detectRecurring` per history | precision / recall / F1 over subscriptions; accuracy of merchant, cadence, amount, next charge date |
| Email extraction | 72 synthetic emails (+ samples) | `isRelevantEmail` → `extractEmailSignal`, the same path as `pipeline.ts` | kind accuracy and macro-F1; trial precision / recall / F1; per-field accuracy |
| End-to-end reconcile | 8 multi-step scenarios | each step: extract emails, add charges, `detectRecurring` + `reconcile`, carry items forward | scenarios fully right; checks passed; steps with duplicate items |
| LLM comparison (opt-in) | the email set | `llmExtract` via a metered client, merged the way `pipeline.ts` merges | the email metrics for rules, LLM-only and rules+LLM, side by side |

**How a detection counts as found.** Every charge in a labeled history that belongs to a subscription carries a
`sub` label. A detection matches the subscription whose charges it is built from (most shared transaction ids),
whatever name it gives it. A detection built from noise (coffee, rent, a fee line) is a false positive; a second
detection for the same subscription is too. Field accuracy for recurring detection is measured on matched
detections only, since a miss already counts against recall.

**Email fields are scored end to end.** A labeled field is wrong when the email produced no signal at all,
because that is what the alert sees. A field the case doesn't label isn't scored. A field labeled `null` must be
absent; that is how "a price in euros must not be stored as dollars" is tested.

**Rates with nothing to score** print as `n/a` and are never gated.

## The baseline gate (CI)

`evals/baseline.json` holds the rules-only metrics and a fingerprint of each dataset. A run fails (exit 1) when:

- any metric dropped by more than `tolerance` (0.01 by default; `--tolerance` overrides it for one run),
- a metric in the baseline is missing from the run, or
- a dataset changed since the baseline was recorded. Adding or relabeling cases changes what is measured, so
  re-record the baseline in the same commit: `npm run eval -- --update-baseline`.

Rules-only extraction is deterministic, so every drop is real. With 72 emails one case is worth about 0.014, so the
default tolerance flags any single email that newly goes wrong. Improvements are listed too; record them with
`--update-baseline` so they are protected from then on. LLM results are never gated (they vary run to run and cost money).

To run it in CI, add a step after the tests: `- run: npm run eval -- --quiet`.

## LLM comparison

```bash
npm run eval -- --llm                                       # plan only: calls, token estimate, cost estimate
npm run eval -- --llm --yes                                 # make the calls with llm.ts's model
npm run eval -- --llm --yes --model claude-sonnet-5-5 --model claude-opus-5-5
npm run eval -- --llm --yes --llm-scope needed              # only the emails the pipeline would send
```

- Needs `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (the same check the API uses). Without them the section is skipped.
- Before any call it prints the number of calls per model and an approximate cost, then stops unless `--yes` is
  given. The estimate assumes ~3.5 characters per input token and ~600 output tokens per call (JSON plus thinking
  at effort `low`); actual token usage and cost are printed after the run. Prices live in `PRICING` in
  `llm-compare.ts`. A model missing there still runs; its cost shows as unknown.
- `--model` (repeatable or comma-separated) measures cheaper models against the default. `llm.ts` reads
  `TRIALGUARD_LLM_MODEL` once at import, so the runner sets it from the first `--model` and also overrides the model
  on every request, which is what lets one run compare several models.
- `claude-haiku-4-5` rejects `output_config.effort`, which `llm.ts` always sends. The runner warns about it; every
  call will fail until `llm.ts` makes `effort` model-dependent.
- Scope `all` (default) calls the model for every email that passes the relevance filter, which gives an
  LLM-only column. Scope `needed` calls it only where `needsLlmExtraction` says the rules result is incomplete,
  which is what production pays for.
- Columns: **rules** is the baseline. **llm only** is the model's policy-checked result for each email.
  **rules+llm** is what the pipeline stores: `mergeSignals(rules, llm)` wherever `needsLlmExtraction(rules)`, the
  rules result elsewhere. The run also lists which emails rules+LLM fixed and which it broke.

The email bodies go to Anthropic's API in this mode. The fixtures are synthetic; never run it over a samples
folder holding real emails unless that is covered by the same consent as production extraction.

## Layout

```
evals/
  run.ts               CLI: runs the tasks, prints tables, gates on the baseline, writes the report
  metrics.ts           precision/recall/F1, confusion matrix, field scoring, overlap matching, baseline comparison
  dataset.ts           loads fixtures + JSON samples, validates them with zod, checks label consistency
  types.ts             case schemas (the format of JSON samples)
  tasks/               one scorer per task (recurring.ts, emails.ts, e2e.ts)
  llm-compare.ts       cost estimate, metered client, rules-vs-LLM comparison
  report.ts            flat metrics for the baseline, text tables
  fixtures/            synthetic cases (transactions.ts, emails.ts, scenarios.ts) and samples/*.json
  baseline.json        committed rules-only baseline
  results/             run reports (git-ignored)
```

## Labeling conventions

Label what is **true**, never what the engine currently outputs. A case the engine gets wrong is the point.

Recurring histories (`RecurringCase` in `types.ts`):

- `today` is the day detection runs. `expected` lists every subscription that is still live on that day; a
  subscription that stopped charging months ago is not expected (it is a negative).
- Mark every charge that belongs to a subscription with its `sub` label, including same-day duplicates and the
  charges before a price change. Leave noise unlabeled.
- `merchantId` for catalog merchants (`packages/core/src/merchants.ts`), otherwise `name`: a word or phrase the
  detected name must contain (case and punctuation ignored). For an app billed through Google Play or the App Store
  whose name is in the descriptor, label the app's merchant; for `APPLE.COM/BILL` label `apple-app-store`.
- `amountCents` is the current price (the latest charge). Leave `cadence` out when the true cadence has no enum
  value (every 2 weeks, every 6 months); use `monthly` for every-4-weeks billing and label the real next date.
- Rent, utilities, loan payments, fees, refund-and-reorder and habits are negatives: they recur, but they are not
  something to cancel from a subscription tracker.

Emails (`EmailCase`):

- `kind` is `trial_signup` (a trial started, or a reminder that one is ending), `receipt` (a charge or renewal,
  including an upcoming-renewal notice), `price_increase`, `cancellation_confirmation`, or `none` (marketing,
  one-off orders, a trial that ended without converting, anything else). `none` cases label nothing else.
- `merchantId` is required for the other kinds: the catalog id, or `null` plus `serviceName` when the service is not
  in the catalog.
- `priceCents` is what will be charged each period in USD: after the trial; the total including tax when the email
  shows one; the new price for an increase. Any other currency is `null`.
- Trial lengths count 30 days per month; `chargeDate` uses the calendar (a one-month trial from Sep 14 converts
  Oct 14). Label `chargeDate` when it is stated or follows from the length; label `trialDays` only when stated.
- Leave a field out when the email doesn't say (for example the cadence of a trial with no price).

Scenarios (`Scenario`): each step has a `today`, the emails and charges that arrived since the last step, an
optional `userCancels` (the "I cancelled" button), and the items expected afterwards. Items are identified by
`merchantId` or a name phrase; only the fields you list are checked.

## Adding real, anonymized samples

Synthetic cases only cover the formats we thought of. Real samples are how the eval learns about the ones we
didn't. Only use data from people who agreed to it, and anonymize **before** the data leaves their machine or
lands in a ticket, chat or commit.

**Strip or replace** (keep the same shape so parsing behaves the same, e.g. replace digits with other digits):

- people's names (greetings, "Hi Sam", signatures, Zelle/Venmo payee names in descriptors);
- postal addresses, phone numbers, the recipient's email address, IP addresses, precise locations;
- card numbers and last-four digits (use `4242`), bank account and routing numbers;
- order, invoice, receipt, transaction, member and account ids; promo codes; tracking numbers;
- links and anything with a token in it (unsubscribe, "manage account", tracking pixels): delete the URL;
- for bank descriptors of small local businesses, replace the city with another city of similar length.

**Keep**: the merchant name and sender domain (attribution is part of what is measured), the subject, the wording
and layout (including HTML), prices and currency symbols, dates and how they are written, plan names, and the
bank descriptor apart from the ids above. If you shift dates for privacy, shift every date in the sample by the
same number of days and fix any weekday names to match.

**Where to put them:**

- Fully anonymized and approved for the repo: add a JSON file to `evals/fixtures/samples/` (format: see
  `fixtures/samples/example.json` and the schemas in `types.ts`). It is loaded and validated on every run.
  Re-record the baseline in the same commit.
- Not for the repo: keep the files outside it and run `npm run eval -- --samples /path/to/folder`. The baseline gate
  is skipped for such runs because the dataset differs. The run's report (in the git-ignored `evals/results/`)
  then holds case ids and extracted fields from those samples (never email bodies); delete it when you're done.
  Don't combine private samples with `--llm` unless sending them to Anthropic is covered by the consent you have.

**Labeling checklist:** label from the email or statement alone, as a careful reader would; add tags that describe
what makes the case hard (`foreign-currency`, `html`, `hard-negative`, ...); have a second person check cases where
the answer took judgment; run `npm run eval` and read the failures for the new cases, since a surprising failure is
either a product bug (keep it) or a labeling mistake (fix it).
