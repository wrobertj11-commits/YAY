import {
  detectRecurring,
  markCancelled,
  reconcile,
  type EmailSignal,
  type TrackedItem,
  type Transaction,
} from '../../packages/core/src/index.ts';
import { tally, zeroTally, type Tally } from '../metrics.ts';
import type { ExpectedItem, Scenario } from '../types.ts';
import { rulesExtract } from './emails.ts';
import { toTransaction } from './recurring.ts';

export interface E2ECheck {
  scenarioId: string;
  step: number;
  check: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface E2EResult {
  scenarios: number;
  /** Scenarios where every check at every step passed. */
  scenarioPass: Tally;
  checks: Tally;
  /** Steps that ended with more live items than expected: the same subscription tracked twice. */
  duplicateSteps: number;
  byTag: Record<string, Tally>;
  results: E2ECheck[];
}

export interface ScenarioRun {
  checks: E2ECheck[];
  duplicateSteps: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function findItem(items: readonly TrackedItem[], who: { merchantId?: string; name?: string }): TrackedItem | undefined {
  const byId = who.merchantId ? items.find((i) => i.merchantId === who.merchantId) : undefined;
  if (byId || !who.name) return byId;
  const name = norm(who.name);
  return items.find((i) => norm(i.name).includes(name));
}

const label = (e: { merchantId?: string; name?: string }) => e.merchantId ?? `"${e.name}"`;
const sortedSources = (s: readonly string[]) => [...s].sort().join(',');

/** [check, expected, actual] for each field the expectation names; `actual` must equal `expected` to pass. */
function checkItem(items: readonly TrackedItem[], want: ExpectedItem): [string, string, string][] {
  const item = findItem(items, want);
  const who = label(want);
  const fields: [string, string | undefined, string | undefined][] = [
    ['status', want.status, item?.status],
    ['kind', want.kind, item?.kind],
    ['amountCents', want.amountCents?.toString(), item?.amountCents.toString()],
    ['cadence', want.cadence, item?.cadence],
    ['nextChargeDate', want.nextChargeDate, item?.nextChargeDate],
    ['sources', want.sources && sortedSources(want.sources), item && sortedSources(item.sources)],
    [
      'priceChange',
      want.priceChange && `${want.priceChange.oldCents}->${want.priceChange.newCents}`,
      item?.priceChange && `${item.priceChange.oldCents}->${item.priceChange.newCents}`,
    ],
  ];
  const checks: [string, string, string][] = [[`${who} exists`, 'yes', item ? 'yes' : 'no']];
  for (const [field, expected, actual] of fields) {
    if (expected !== undefined) checks.push([`${who} ${field}`, expected, actual ?? '(none)']);
  }
  return checks;
}

/**
 * Replays a scenario the way the API's sync does it: each step ingests its emails through the rules
 * path (relevance filter + extractEmailSignal), adds its bank charges, applies a user cancellation if
 * there is one, then reruns detectRecurring + reconcile over everything seen so far, carrying the
 * items forward like the store does between syncs.
 */
export function runScenario(s: Scenario): ScenarioRun {
  let items: TrackedItem[] = [];
  const transactions: Transaction[] = [];
  const signals: EmailSignal[] = [];
  let seq = 0;
  const newId = () => `itm_${++seq}`;
  const checks: E2ECheck[] = [];
  let duplicateSteps = 0;
  const record = (step: number, check: string, expected: string, actual: string, pass: boolean) =>
    checks.push({ scenarioId: s.id, step, check, expected, actual, pass });

  s.steps.forEach((step, i) => {
    const now = `${step.today}T12:00:00.000Z`;
    for (const email of step.emails) {
      const signal = rulesExtract({ ...email });
      if (signal) signals.push(signal);
    }
    transactions.push(...step.transactions.map(toTransaction));

    if (step.userCancels) {
      const target = findItem(items, { merchantId: step.userCancels, name: step.userCancels });
      record(i + 1, `user cancels ${step.userCancels}`, 'item found', target ? 'item found' : 'no item', Boolean(target));
      if (target) items = items.map((it) => (it.id === target.id ? markCancelled(it, step.today, now) : it));
    }

    ({ items } = reconcile({
      items,
      transactions,
      recurring: detectRecurring(transactions, { today: step.today }),
      signals,
      today: step.today,
      now,
      newId,
    }));

    if (!step.expect) return;
    const live = items.filter((it) => it.status !== 'dismissed');
    const wantCount = step.expect.itemCount;
    if (wantCount !== undefined) {
      const names = live.map((it) => it.name).join(', ');
      record(i + 1, 'item count', String(wantCount), `${live.length} (${names})`, live.length === wantCount);
      if (live.length > wantCount) duplicateSteps += 1;
    }
    for (const want of step.expect.items) {
      for (const [check, expected, actual] of checkItem(live, want)) record(i + 1, check, expected, actual, actual === expected);
    }
  });
  return { checks, duplicateSteps };
}

export function evaluateScenarios(scenarios: readonly Scenario[]): E2EResult {
  let scenarioPass = zeroTally();
  let checks = zeroTally();
  let duplicateSteps = 0;
  const byTag: Record<string, Tally> = {};
  const results: E2ECheck[] = [];

  for (const s of scenarios) {
    const run = runScenario(s);
    results.push(...run.checks);
    duplicateSteps += run.duplicateSteps;
    for (const c of run.checks) checks = tally(checks, c.pass ? 'correct' : 'wrong');
    const pass = run.checks.every((c) => c.pass) ? 'correct' : 'wrong';
    scenarioPass = tally(scenarioPass, pass);
    for (const tag of s.tags) byTag[tag] = tally(byTag[tag] ?? zeroTally(), pass);
  }
  return { scenarios: scenarios.length, scenarioPass, checks, duplicateSteps, byTag, results };
}
