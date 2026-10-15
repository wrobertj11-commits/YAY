import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import * as apiLlm from '../apps/api/src/llm.ts';
import type { EmailSignal, RecurringCharge } from '../packages/core/src/index.ts';
import { DatasetError, checkIntegrity, loadDataset, type Dataset } from './dataset.ts';
import { EMAIL_CASES } from './fixtures/emails.ts';
import {
  OUTPUT_TOKENS_PER_CALL,
  compareModel,
  costUsd,
  emailsToCall,
  estimateCost,
  hasCredentials,
  mapLimit,
  meteredClient,
  zeroUsage,
  type ParseSdk,
} from './llm-compare.ts';
import { datasetFingerprints, emailMetrics, table } from './report.ts';
import { runScenario } from './tasks/e2e.ts';
import { evaluateEmails, rulesExtract, scoreEmails, toEmailMessage } from './tasks/emails.ts';
import { evaluateRecurring, type Detector } from './tasks/recurring.ts';

const ds = loadDataset();
const tmpDirs: string[] = [];

/** Indexed access that fails the test (instead of returning undefined) when the element is missing. */
function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  assert.ok(v !== undefined, `expected an element at index ${i} (length ${list.length})`);
  return v;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function sampleDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'trialguard-evals-'));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}

describe('dataset', () => {
  it('has the coverage the evals promise', () => {
    assert.ok(ds.recurring.length >= 40, `${ds.recurring.length} transaction series`);
    assert.ok(ds.emails.length >= 60, `${ds.emails.length} emails`);
    assert.ok(ds.scenarios.length >= 3, `${ds.scenarios.length} scenarios`);
    const tags = new Set(ds.recurring.flatMap((c) => c.tags));
    for (const t of ['hard-negative', 'hard-positive', 'habit', 'one-off', 'refunds', 'utility', 'price-increase', 'annual', 'paypal', 'app-store', 'unknown-merchant', 'month-end', 'weekly']) {
      assert.ok(tags.has(t), `recurring tag ${t}`);
    }
    const kinds = new Set(ds.emails.map((c) => c.gold.kind));
    assert.equal(kinds.size, 5, 'every email kind, including none, is represented');
    const emailTags = new Set(ds.emails.flatMap((c) => c.tags));
    for (const t of ['foreign-currency', 'html', 'international', 'marketing', 'no-date', 'words']) assert.ok(emailTags.has(t), `email tag ${t}`);
  });

  it('is deterministic, so the baseline fingerprint is stable', () => {
    assert.deepEqual(datasetFingerprints(loadDataset()), datasetFingerprints(ds));
  });

  it('fills defaults from the schema', () => {
    const t = ds.recurring[0]?.transactions[0];
    assert.equal(t?.paymentMethod, 'Visa ••4242');
    assert.equal(t?.accountId, 'acct-1');
  });

  it('loads JSON samples from extra folders', () => {
    const dir = sampleDir({
      'a.json': {
        emails: [
          {
            id: 'tmp-email',
            note: 'temp',
            email: { id: 'tmp-email-msg', from: 'x@y.example', subject: 'Receipt', date: '2026-09-01T00:00:00Z', body: 'Paid $5.00' },
            gold: { kind: 'receipt', merchantId: null, serviceName: 'Y' },
          },
        ],
      },
    });
    // Only the given folder is read (not the committed samples), on top of the TypeScript fixtures.
    const loaded = loadDataset([dir]);
    assert.equal(loaded.emails.length, EMAIL_CASES.length + 1);
    assert.ok(loaded.emails.some((c) => c.id === 'tmp-email'));
    assert.ok(loaded.sources.some((s) => s.endsWith('a.json')));
  });

  it('rejects a sample file with a bad label, naming the file and field', () => {
    const dir = sampleDir({ 'bad.json': { emails: [{ id: 'x', note: '', email: { id: 'm', from: 'a@b.example', subject: '', date: 'yesterday', body: '' }, gold: { kind: 'trial' } }] } });
    assert.throws(() => loadDataset([dir]), (err: unknown) => err instanceof DatasetError && /bad\.json/.test(err.message) && /date|kind/.test(err.message));
  });

  it('rejects a sample file that is not JSON', () => {
    const dir = sampleDir({ 'broken.json': '{ not json' });
    assert.throws(() => loadDataset([dir]), (err: unknown) => err instanceof DatasetError && /not valid JSON/.test(err.message));
  });

  it('catches label inconsistencies the schema cannot', () => {
    const bad: Dataset = structuredClone(ds);
    const firstRecurring = bad.recurring[0];
    const firstNone = bad.emails.find((c) => c.gold.kind === 'none');
    assert.ok(firstRecurring && firstNone);
    firstRecurring.transactions.push({ ...at(firstRecurring.transactions, 0), id: 'orphan', sub: 'nope' });
    firstNone.gold.priceCents = 100;
    bad.emails.push(structuredClone(at(bad.emails, 0)));
    assert.throws(
      () => checkIntegrity(bad),
      (err: unknown) =>
        err instanceof DatasetError &&
        /sub "nope" with no expected entry/.test(err.message) &&
        /kind "none" must not label fields/.test(err.message) &&
        /duplicate id/.test(err.message),
    );
  });
});

describe('recurring scorer', () => {
  /** Identifies a case by its whole feed (ids like "a-1" repeat across cases). */
  const feedKey = (txns: readonly { id: string; date: string; description: string; amountCents: number }[], today: string) =>
    JSON.stringify([today, txns.map((t) => [t.id, t.date, t.description, t.amountCents])]);
  const byFeed = new Map(ds.recurring.map((c) => [feedKey(c.transactions, c.today), c]));

  /** A detector that returns exactly the labels: everything must score perfectly. */
  const oracle: Detector = (txns, today) => {
    const c = byFeed.get(feedKey(txns, today));
    assert.ok(c, 'oracle found its case');
    return c.expected.map(
      (g): RecurringCharge => ({
        key: g.sub,
        merchantId: g.merchantId,
        name: g.name ?? g.merchantId ?? '',
        rail: 'card',
        cadence: g.cadence ?? 'monthly',
        amountCents: g.amountCents ?? 0,
        lastChargeDate: today,
        nextChargeDate: g.nextChargeDate ?? today,
        paymentMethod: 'Visa',
        transactionIds: c.transactions.filter((t) => t.sub === g.sub).map((t) => t.id),
        priceHistory: [],
        confidence: 1,
      }),
    );
  };

  it('gives a perfect detector perfect scores', () => {
    const r = evaluateRecurring(ds.recurring, oracle);
    assert.deepEqual(r.prf, { precision: 1, recall: 1, f1: 1 });
    assert.equal(r.failures.length, 0);
    assert.equal(r.casePass.correct, r.casePass.total);
  });

  it('gives a detector that finds nothing zero recall but full marks on negatives', () => {
    const r = evaluateRecurring(ds.recurring, () => []);
    assert.equal(r.prf.recall, 0);
    assert.equal(r.negativePass.correct, r.negativePass.total);
    assert.equal(r.counts.fn, r.subscriptions);
  });

  it('counts a detection built from noise as a false positive even if it has the right name', () => {
    const c = ds.recurring.find((rc) => rc.id === 'chatgpt-plus-api-usage');
    assert.ok(c);
    const apiOnly: Detector = (txns, today) => [{ ...at(oracle(txns, today), 0), transactionIds: c.transactions.filter((t) => !t.sub).map((t) => t.id) }];
    const r = evaluateRecurring([c], apiOnly);
    assert.deepEqual(r.counts, { tp: 0, fp: 1, fn: 1 });
  });
});

describe('email scorer', () => {
  /** Turns gold labels back into the signal a perfect extractor would produce. */
  function perfect(i: number): EmailSignal | undefined {
    const c = ds.emails[i];
    assert.ok(c);
    const g = c.gold;
    if (g.kind === 'none') return undefined;
    return {
      kind: g.kind,
      emailId: c.email.id,
      merchantId: g.merchantId ?? undefined,
      serviceName: g.serviceName ?? g.merchantId ?? '',
      receivedAt: c.email.date.slice(0, 10),
      priceCents: g.priceCents ?? undefined,
      oldPriceCents: g.oldPriceCents ?? undefined,
      cadence: g.cadence ?? undefined,
      trialDays: g.trialDays ?? undefined,
      chargeDate: g.chargeDate ?? undefined,
      effectiveDate: g.effectiveDate ?? undefined,
      confidence: 1,
      extractedBy: 'rules',
    };
  }

  it('gives a perfect extractor perfect scores on every field', () => {
    const r = scoreEmails(ds.emails, ds.emails.map((_, i) => perfect(i)));
    assert.equal(r.kindAccuracy, 1);
    assert.equal(r.failures.length, 0);
    for (const v of Object.values(emailMetrics(r))) assert.equal(v, 1);
  });

  it('counts a missing signal as wrong on every labeled field', () => {
    const r = scoreEmails(ds.emails, ds.emails.map(() => undefined));
    assert.equal(r.detect.recall, 0);
    assert.equal(r.fields.priceCents.correct, ds.emails.filter((c) => c.gold.kind !== 'none' && c.gold.priceCents === null).length);
  });

  it('matches the rules path when evaluated end to end', async () => {
    const viaEvaluate = await evaluateEmails(ds.emails);
    const viaScore = scoreEmails(ds.emails, ds.emails.map((c) => rulesExtract(toEmailMessage(c))));
    assert.deepEqual(emailMetrics(viaEvaluate), emailMetrics(viaScore));
  });
});

describe('end-to-end scorer', () => {
  it('passes a scenario the engine handles', () => {
    const s = ds.scenarios.find((sc) => sc.id === 'max-trial-then-charge');
    assert.ok(s);
    const run = runScenario(s);
    assert.deepEqual(run.checks.filter((c) => !c.pass), []);
    assert.equal(run.duplicateSteps, 0);
  });
});

describe('LLM comparison (offline, fake SDK)', () => {
  it('estimates tokens and cost from the request text', () => {
    const req = { system: 'x'.repeat(35), output_config: { format: { a: 1 } }, messages: [{ role: 'user' as const, content: 'y'.repeat(28) }] };
    const e = estimateCost('claude-opus-5-5', [req, req]);
    const chars = 2 * (35 + JSON.stringify({ a: 1 }).length + 28);
    assert.equal(e.inputTokens, Math.ceil(chars / 3.5));
    assert.equal(e.outputTokens, 2 * OUTPUT_TOKENS_PER_CALL);
    assert.equal(e.usd, costUsd('claude-opus-5-5', e.inputTokens, e.outputTokens));
    assert.equal(estimateCost('some-unpriced-model', [req]).usd, undefined);
  });

  it('prices per million tokens', () => {
    assert.equal(costUsd('claude-opus-5-5', 1_000_000, 1_000_000), 24);
    assert.equal(costUsd('claude-sonnet-5-5', 500_000, 0), 1);
  });

  it('checks credentials the same way the API does', () => {
    assert.equal(hasCredentials({}), false);
    assert.equal(hasCredentials({ ANTHROPIC_API_KEY: '' }), false);
    assert.equal(hasCredentials({ ANTHROPIC_AUTH_TOKEN: 't' }), true);
  });

  it('runs work with bounded concurrency and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });

  it('sends every request to the chosen model and meters usage and errors', async () => {
    const seen: string[] = [];
    let fail = false;
    const sdk: ParseSdk = {
      messages: {
        parse: async (params) => {
          seen.push(params.model);
          if (fail) throw new Error('boom');
          return { stop_reason: 'end_turn', parsed_output: null, usage: { input_tokens: 100, output_tokens: 20 } };
        },
      },
    };
    const usage = zeroUsage();
    const client = meteredClient(sdk, 'claude-sonnet-5-5', usage);
    const email = toEmailMessage(at(ds.emails, 0));
    await client.messages.parse(apiLlm.buildExtractionRequest(email));
    fail = true;
    await assert.rejects(Promise.resolve(client.messages.parse(apiLlm.buildExtractionRequest(email))));
    assert.deepEqual(seen, ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
    assert.deepEqual(usage, { calls: 2, errors: 1, inputTokens: 100, outputTokens: 20 });
  });

  it('scores rules+LLM the way the pipeline merges, through the real llm.ts', async () => {
    // The fake model only knows one thing: the Canva trial converts on 2026-10-21 after 30 days.
    const sdk: ParseSdk = {
      messages: {
        parse: async (params) => {
          const canva = params.messages.some((m) => m.content.includes('Canva Pro costs'));
          const parsed_output = canva
            ? { kind: 'trial_signup', service_name: 'Canva Pro', price: 14.99, old_price: null, billing_period: 'monthly', trial_length_days: 30, charge_date: '2026-10-21', effective_date: null }
            : { kind: 'other', service_name: null, price: null, old_price: null, billing_period: null, trial_length_days: null, charge_date: null, effective_date: null };
          return { stop_reason: 'end_turn', parsed_output, usage: { input_tokens: 10, output_tokens: 5 } };
        },
      },
    };
    const cases = ds.emails.filter((c) => ['trial-usd-suffix', 'trial-spotify-iso', 'none-marketing-trial'].includes(c.id));
    const rules = scoreEmails(cases, cases.map((c) => rulesExtract(toEmailMessage(c))));
    const r = await compareModel(cases, { model: 'claude-opus-5-5', scope: 'all', sdk, api: apiLlm, concurrency: 2 });

    assert.equal(r.usage.calls, emailsToCall(cases, 'all').length);
    assert.ok(rules.failures.some((f) => f.caseId === 'trial-usd-suffix'), 'the rules miss the Canva conversion date');
    assert.ok(!r.rulesPlusLlm.failures.some((f) => f.caseId === 'trial-usd-suffix'), 'the LLM fills it in');
    // A complete rules result is never sent through the merge, so the model's "other" can't erase it.
    assert.ok(!r.rulesPlusLlm.failures.some((f) => f.caseId === 'trial-spotify-iso'));
    assert.equal(r.llmOnly?.perKind.trial_signup.support, 2);
  });
});

describe('report formatting', () => {
  it('right-aligns numeric columns and left-aligns text', () => {
    const out = table(['metric', 'value', 'detail'], [['precision', '0.750', 'tp 3, fp 1'], ['f1', '1.000', '3/3']]);
    assert.equal(out, ['  metric     value  detail', '  precision  0.750  tp 3, fp 1', '  f1         1.000  3/3'].join('\n'));
  });
});
