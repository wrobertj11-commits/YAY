/**
 * Accuracy evals for Trialguard's detection and extraction.
 *
 *   node evals/run.ts                     rules-only evals + baseline gate (what CI runs)
 *   node evals/run.ts --update-baseline   re-record evals/baseline.json from this run
 *   node evals/run.ts --llm               also plan a rules-vs-LLM comparison (prints calls and cost, then stops)
 *   node evals/run.ts --llm --yes         ...and make the calls
 *   node evals/run.ts --llm --yes --model claude-sonnet-5-5 --model claude-opus-5-5
 *
 * Exit codes: 0 pass, 1 baseline gate failed, 2 bad usage or invalid dataset.
 * See evals/README.md for what is measured and how to add cases.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DatasetError, EVALS_DIR, SAMPLES_DIR, loadDataset, type Dataset } from './dataset.ts';
import {
  CHARS_PER_TOKEN,
  KNOWN_INCOMPATIBLE,
  OUTPUT_TOKENS_PER_CALL,
  compareModel,
  emailsToCall,
  estimateCost,
  hasCredentials,
  type LlmScope,
  type ModelComparison,
  type ParseSdk,
} from './llm-compare.ts';
import { compareToBaseline, round, type Baseline, type GateResult, type MetricSnapshot } from './metrics.ts';
import { emailMetrics, formatE2E, formatEmails, formatGate, formatRecurring, snapshotOf, table, usd } from './report.ts';
import { evaluateScenarios } from './tasks/e2e.ts';
import { evaluateEmails, toEmailMessage, type EmailResult } from './tasks/emails.ts';
import { evaluateRecurring } from './tasks/recurring.ts';

const BASELINE_FILE = path.join(EVALS_DIR, 'baseline.json');
const RESULTS_DIR = path.join(EVALS_DIR, 'results');
const DEFAULT_TOLERANCE = 0.01;

const BaselineSchema = z.looseObject({
  tolerance: z.number().min(0).max(1),
  datasets: z.record(z.string(), z.string()),
  metrics: z.record(z.string(), z.number()),
});

const HELP = `Usage: node evals/run.ts [options]

  --update-baseline     write this run's rules-only metrics to evals/baseline.json
  --tolerance <n>       allowed drop per metric before the gate fails (default: the baseline's, ${DEFAULT_TOLERANCE})
  --samples <dir>       also load *.json samples from <dir> (repeatable); the baseline gate is skipped
  --llm                 compare rules-only with rules+LLM (needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)
  --yes                 confirm the LLM calls after reading the estimate
  --model <id>          model to measure (repeatable or comma-separated; default: llm.ts's model)
  --llm-scope all|needed  call the model for every relevant email (default), or only where the pipeline would
  --concurrency <n>     parallel model calls (default 4)
  --quiet               hide the per-case failure lists
  --help`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function parseCli() {
  try {
    const { values } = parseArgs({
      options: {
        'update-baseline': { type: 'boolean', default: false },
        tolerance: { type: 'string' },
        samples: { type: 'string', multiple: true, default: [] },
        llm: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        model: { type: 'string', multiple: true, default: [] },
        'llm-scope': { type: 'string', default: 'all' },
        concurrency: { type: 'string', default: '4' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
    return values;
  } catch (err) {
    return fail(`${(err as Error).message}\n\n${HELP}`);
  }
}

function readBaseline(): Baseline | undefined {
  let raw: string;
  try {
    raw = readFileSync(BASELINE_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = BaselineSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return fail(`${BASELINE_FILE}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function writeBaseline(snapshot: MetricSnapshot, tolerance: number): void {
  const body = {
    $comment: 'Rules-only metrics recorded by `npm run eval -- --update-baseline`. CI fails when a metric drops by more than `tolerance` or a dataset fingerprint changes.',
    tolerance,
    datasets: snapshot.datasets,
    metrics: snapshot.metrics,
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`);
}

function writeReport(report: unknown): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(RESULTS_DIR, `${stamp}.json`);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(file, text);
  writeFileSync(path.join(RESULTS_DIR, 'latest.json'), text);
  return file;
}

// ---------- LLM comparison ----------

interface LlmSection {
  scope: LlmScope;
  status: 'skipped' | 'planned' | 'ran';
  reason?: string;
  estimates: ReturnType<typeof estimateCost>[];
  models: ModelComparison[];
}

async function runLlmSection(ds: Dataset, args: ReturnType<typeof parseCli>): Promise<LlmSection> {
  const scope = args['llm-scope'];
  if (scope !== 'all' && scope !== 'needed') return fail(`--llm-scope must be "all" or "needed", got "${scope}"`);
  const concurrency = Number(args.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) return fail('--concurrency must be an integer from 1 to 16');
  const section: LlmSection = { scope, status: 'skipped', estimates: [], models: [] };

  console.log('\nLLM extraction (apps/api/src/llm.ts)');
  if (!hasCredentials()) {
    section.reason = 'no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment';
    console.log(`  skipped: ${section.reason}`);
    return section;
  }

  // llm.ts reads TRIALGUARD_LLM_MODEL once at import, so set it before the first import. Each call also
  // overrides the model (meteredClient), which is what lets one run measure several models.
  const requested = args.model.flatMap((m) => m.split(',')).map((m) => m.trim()).filter(Boolean);
  if (requested[0]) process.env.TRIALGUARD_LLM_MODEL = requested[0];
  const api = await import('../apps/api/src/llm.ts');

  const targets = emailsToCall(ds.emails, scope);
  const requests = targets.map((c) => api.buildExtractionRequest(toEmailMessage(c)));
  const defaultModel = requests[0]?.model;
  const models = requested.length ? [...new Set(requested)] : defaultModel ? [defaultModel] : [];
  if (!models.length) {
    section.reason = 'no emails need a model call';
    console.log(`  skipped: ${section.reason}`);
    return section;
  }
  section.estimates = models.map((m) => estimateCost(m, requests));

  console.log(`  ${targets.length} of ${ds.emails.length} emails per model (scope "${scope}"); ${targets.length * models.length} calls in total`);
  console.log(
    table(
      ['model', 'calls', 'est. input tok', 'est. output tok', 'est. cost'],
      section.estimates.map((e) => [e.model, String(e.calls), String(e.inputTokens), String(e.outputTokens), usd(e.usd)]),
    ),
  );
  const total = section.estimates.every((e) => e.usd !== undefined) ? section.estimates.reduce((s, e) => s + (e.usd ?? 0), 0) : undefined;
  console.log(
    `  estimated total: ${usd(total)} (rough: ~${CHARS_PER_TOKEN} chars per input token, ~${OUTPUT_TOKENS_PER_CALL} output tokens per call; actual usage is printed after the run)`,
  );
  for (const m of models) if (KNOWN_INCOMPATIBLE[m]) console.log(`  warning: ${m} ${KNOWN_INCOMPATIBLE[m]}; expect every call to fail`);

  if (!args.yes) {
    section.status = 'planned';
    section.reason = 'not confirmed';
    console.log('  Not calling the API. Re-run with --yes to make these calls.');
    return section;
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const sdk: ParseSdk = new Anthropic();
  for (const model of models) {
    const result = await compareModel(ds.emails, {
      model,
      scope,
      sdk,
      api,
      concurrency,
      onProgress: (done, n) => {
        if (done % 10 === 0 || done === n) process.stderr.write(`  ${model}: ${done}/${n}\n`);
      },
    });
    section.models.push(result);
  }
  section.status = 'ran';
  return section;
}

/** Emails that are fully right in `after` but not in `before` (fixed), and the reverse (broken). */
function caseDiff(before: EmailResult, after: EmailResult): { fixed: string[]; broken: string[] } {
  const wrong = (r: EmailResult) => new Set(r.failures.map((f) => f.caseId));
  const [b, a] = [wrong(before), wrong(after)];
  return { fixed: [...b].filter((id) => !a.has(id)), broken: [...a].filter((id) => !b.has(id)) };
}

function printLlmComparison(rules: EmailResult, section: LlmSection, quiet: boolean): void {
  const rulesMetrics = emailMetrics(rules);
  // The relevance filter runs before any extractor, so its recall is the same in every column.
  const keys = Object.keys(rulesMetrics).filter((k) => !k.endsWith('.gate.recall'));
  for (const m of section.models) {
    const systems: [string, Record<string, number>][] = [['rules', rulesMetrics]];
    if (m.llmOnly) systems.push(['llm only', emailMetrics(m.llmOnly)]);
    systems.push(['rules+llm', emailMetrics(m.rulesPlusLlm)]);
    const cell = (v: number | undefined) => (v === undefined ? 'n/a' : v.toFixed(3));
    console.log(
      `\n  ${m.model}: ${m.usage.calls} calls, ${m.usage.errors} errors, ${m.usage.inputTokens} input + ${m.usage.outputTokens} output tokens, cost ${usd(m.costUsd)}`,
    );
    console.log(table(['metric', ...systems.map(([name]) => name)], keys.map((k) => [k.replace(/^emails\./, ''), ...systems.map(([, s]) => cell(s[k]))])));
    const { fixed, broken } = caseDiff(rules, m.rulesPlusLlm);
    console.log(`  rules+llm vs rules: ${fixed.length} emails fixed, ${broken.length} broken`);
    if (!quiet) {
      if (fixed.length) console.log(`    fixed: ${fixed.join(', ')}`);
      if (broken.length) console.log(`    broken: ${broken.join(', ')}`);
    }
  }
}

// ---------- main ----------

async function main(): Promise<number> {
  const args = parseCli();
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const extraSamples = args.samples.map((d) => path.resolve(d));
  if (args['update-baseline'] && extraSamples.length) fail('--update-baseline records the committed dataset only; drop --samples');

  let ds: Dataset;
  try {
    ds = loadDataset([SAMPLES_DIR, ...extraSamples]);
  } catch (err) {
    if (err instanceof DatasetError) return fail(err.message);
    throw err;
  }
  const failureLimit = args.quiet ? 0 : 60;

  const recurring = evaluateRecurring(ds.recurring);
  const emails = await evaluateEmails(ds.emails);
  const e2e = evaluateScenarios(ds.scenarios);
  const snapshot = snapshotOf(ds, { recurring, emails, e2e });

  console.log(`Trialguard accuracy evals (rules only) — ${ds.sources.join(', ')}\n`);
  console.log(formatRecurring(recurring, { failureLimit }));
  console.log(`\n${formatEmails(emails, { failureLimit })}`);
  console.log(`\n${formatE2E(e2e, { failureLimit })}\n`);

  const baseline = readBaseline();
  const toleranceArg = args.tolerance === undefined ? undefined : Number(args.tolerance);
  if (toleranceArg !== undefined && !(toleranceArg >= 0 && toleranceArg <= 1)) fail('--tolerance must be a number from 0 to 1');
  const tolerance = round(toleranceArg ?? baseline?.tolerance ?? DEFAULT_TOLERANCE);

  let gate: GateResult | { skipped: string };
  if (args['update-baseline']) {
    writeBaseline(snapshot, tolerance);
    gate = { skipped: 'baseline re-recorded' };
    console.log(`Baseline written to ${path.relative(process.cwd(), BASELINE_FILE)} (tolerance ${tolerance}).`);
  } else if (extraSamples.length) {
    gate = { skipped: '--samples changes the dataset, so the numbers are not comparable with the baseline' };
    console.log(`Baseline gate: skipped (${gate.skipped}).`);
  } else if (!baseline) {
    gate = { skipped: 'no baseline file' };
    console.log('Baseline gate: FAIL (no evals/baseline.json; record one with --update-baseline).');
  } else {
    gate = compareToBaseline(snapshot, baseline, tolerance);
    console.log(formatGate(gate, tolerance));
  }

  const llm = args.llm ? await runLlmSection(ds, args) : undefined;
  if (llm?.status === 'ran') printLlmComparison(emails, llm, args.quiet);

  const file = writeReport({
    generatedAt: new Date().toISOString(),
    node: process.version,
    dataset: {
      sources: ds.sources,
      counts: { recurring: ds.recurring.length, emails: ds.emails.length, scenarios: ds.scenarios.length },
      fingerprints: snapshot.datasets,
    },
    rules: { metrics: snapshot.metrics, recurring, emails, e2e },
    gate,
    llm: llm && {
      ...llm,
      models: llm.models.map((m) => ({
        model: m.model,
        scope: m.scope,
        usage: m.usage,
        costUsd: m.costUsd,
        metrics: { llmOnly: m.llmOnly && emailMetrics(m.llmOnly), rulesPlusLlm: emailMetrics(m.rulesPlusLlm) },
        llmOnly: m.llmOnly && { failures: m.llmOnly.failures, predictions: m.llmOnly.predictions },
        rulesPlusLlm: { failures: m.rulesPlusLlm.failures, predictions: m.rulesPlusLlm.predictions },
      })),
    },
  });
  console.log(`\nReport: ${path.relative(process.cwd(), file)}`);

  const gateFailed = 'ok' in gate ? !gate.ok : gate.skipped === 'no baseline file';
  return gateFailed ? 1 : 0;
}

process.exitCode = await main();
