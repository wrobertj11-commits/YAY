import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EMAIL_CASES } from './fixtures/emails.ts';
import { SCENARIOS } from './fixtures/scenarios.ts';
import { RECURRING_CASES } from './fixtures/transactions.ts';
import { EmailCase, RecurringCase, SampleFile, Scenario } from './types.ts';

export const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Committed JSON samples (anonymized real data goes here once labeled; see README). */
export const SAMPLES_DIR = path.join(EVALS_DIR, 'fixtures', 'samples');

export interface Dataset {
  recurring: RecurringCase[];
  emails: EmailCase[];
  scenarios: Scenario[];
  /** Where cases came from, for the report header. */
  sources: string[];
}

export class DatasetError extends Error {
  name = 'DatasetError';
}

/** zod's message, prefixed with where the bad case lives. */
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new DatasetError(`${where}: ${z.prettifyError(r.error)}`);
  return r.data;
}

function readSampleDir(dir: string): { file: string; data: SampleFile }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new DatasetError(`${file}: not valid JSON (${(err as Error).message})`);
    }
    return { file, data: parseOrThrow(SampleFile, json, file) };
  });
}

/**
 * The full labeled dataset: the synthetic fixtures plus every JSON sample file in `sampleDirs`.
 * Everything goes through the zod schemas and the integrity checks below, so a typo in a hand-written
 * label fails the run instead of quietly changing what is measured.
 */
export function loadDataset(sampleDirs: readonly string[] = [SAMPLES_DIR]): Dataset {
  const ds: Dataset = {
    recurring: RECURRING_CASES.map((c) => parseOrThrow(RecurringCase, c, `fixtures/transactions.ts case ${c.id}`)),
    emails: EMAIL_CASES.map((c) => parseOrThrow(EmailCase, c, `fixtures/emails.ts case ${c.id}`)),
    scenarios: SCENARIOS.map((c) => parseOrThrow(Scenario, c, `fixtures/scenarios.ts case ${c.id}`)),
    sources: ['fixtures/transactions.ts', 'fixtures/emails.ts', 'fixtures/scenarios.ts'],
  };
  for (const dir of sampleDirs) {
    for (const { file, data } of readSampleDir(dir)) {
      ds.recurring.push(...data.recurring);
      ds.emails.push(...data.emails);
      ds.scenarios.push(...data.scenarios);
      ds.sources.push(path.relative(EVALS_DIR, file));
    }
  }
  checkIntegrity(ds);
  return ds;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((v) => (seen.has(v) ? true : (seen.add(v), false))))];
}

/** Cross-field rules the schemas can't express. Throws one DatasetError listing every problem. */
export function checkIntegrity(ds: Dataset): void {
  const problems: string[] = [];
  const dupIds = (label: string, ids: string[]) => {
    for (const d of duplicates(ids)) problems.push(`${label}: duplicate id "${d}"`);
  };

  dupIds('recurring', ds.recurring.map((c) => c.id));
  for (const c of ds.recurring) {
    dupIds(`recurring/${c.id} transactions`, c.transactions.map((t) => t.id));
    dupIds(`recurring/${c.id} expected`, c.expected.map((e) => e.sub));
    const subs = new Set(c.expected.map((e) => e.sub));
    for (const t of c.transactions) {
      if (t.sub !== undefined && !subs.has(t.sub)) problems.push(`recurring/${c.id}: transaction ${t.id} has sub "${t.sub}" with no expected entry`);
    }
    for (const e of c.expected) {
      if (!c.transactions.some((t) => t.sub === e.sub)) problems.push(`recurring/${c.id}: expected "${e.sub}" has no labeled transactions`);
      if (!e.merchantId && !e.name) problems.push(`recurring/${c.id}: expected "${e.sub}" needs merchantId or name`);
    }
  }

  dupIds('emails', ds.emails.map((c) => c.id));
  dupIds('email message ids', ds.emails.map((c) => c.email.id));
  for (const c of ds.emails) {
    const { kind, ...fields } = c.gold;
    const labeled = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k]) => k);
    if (kind === 'none' && labeled.length) problems.push(`emails/${c.id}: kind "none" must not label fields (${labeled.join(', ')})`);
    if (kind !== 'none' && c.gold.merchantId === undefined) problems.push(`emails/${c.id}: label merchantId (null + serviceName when outside the catalog)`);
    if (c.gold.merchantId === null && !c.gold.serviceName) problems.push(`emails/${c.id}: merchantId null needs a serviceName`);
  }

  dupIds('scenarios', ds.scenarios.map((s) => s.id));
  for (const s of ds.scenarios) {
    dupIds(`scenarios/${s.id} email ids`, s.steps.flatMap((st) => st.emails.map((e) => e.id)));
    dupIds(`scenarios/${s.id} transaction ids`, s.steps.flatMap((st) => st.transactions.map((t) => t.id)));
    s.steps.forEach((st, i) => {
      for (const it of st.expect?.items ?? []) {
        if (!it.merchantId && !it.name) problems.push(`scenarios/${s.id} step ${i + 1}: expected item needs merchantId or name`);
      }
    });
  }

  if (problems.length) throw new DatasetError(`dataset has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
}
