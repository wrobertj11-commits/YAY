import { isRelevantEmail, needsLlmExtraction, type EmailMessage, type EmailSignal } from '../packages/core/src/index.ts';
import type { ExtractionClient, ExtractionRequest } from '../apps/api/src/llm.ts';
import { scoreEmails, rulesExtract, toEmailMessage, type EmailResult } from './tasks/emails.ts';
import type { EmailCase } from './types.ts';

/**
 * Rules-only vs. rules+LLM on the labeled email set, through apps/api/src/llm.ts exactly as the API
 * calls it. Nothing here touches the network by itself: the SDK client is passed in (run.ts builds
 * the real one only after --llm, credentials and --yes), so tests drive it with a fake.
 */

// ---------- cost ----------

/**
 * Anthropic first-party list prices in USD per million tokens, as of 2026-09. Only used for the
 * estimate printed before a run and the cost printed after it; update when prices change.
 * A model missing here still runs; its cost shows as unknown.
 */
export const PRICING: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
};

/**
 * Models known to reject part of the request llm.ts always builds. Their calls fail with a 400 (not
 * billed), llmExtract returns nothing, and the scores would only measure that. Warned about up front.
 */
export const KNOWN_INCOMPATIBLE: Readonly<Record<string, string>> = {
  'claude-haiku-4-5': 'rejects output_config.effort, which apps/api/src/llm.ts always sends',
};

/** Rough English-text ratio; JSON schemas and HTML tokenize a little denser, so this errs high on cost. */
export const CHARS_PER_TOKEN = 3.5;
/** Structured JSON (~150 tokens) plus thinking at effort "low". A guess: the actual usage is printed after the run. */
export const OUTPUT_TOKENS_PER_CALL = 600;

export interface Estimate {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | undefined;
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const p = PRICING[model];
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : undefined;
}

/** The parts of a request that become input tokens. */
type RequestText = Pick<ExtractionRequest, 'system' | 'messages'> & { output_config: { format: unknown } };

export function estimateCost(model: string, requests: readonly RequestText[]): Estimate {
  let chars = 0;
  for (const r of requests) {
    chars += r.system.length + JSON.stringify(r.output_config.format).length;
    for (const m of r.messages) chars += m.content.length;
  }
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const outputTokens = requests.length * OUTPUT_TOKENS_PER_CALL;
  return { model, calls: requests.length, inputTokens, outputTokens, usd: costUsd(model, inputTokens, outputTokens) };
}

/** Same check the API uses to decide whether LLM extraction is on (apps/api/src/config.ts). */
export function hasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN);
}

// ---------- calls ----------

/** The slice of the Anthropic SDK this module uses. An `Anthropic` instance satisfies it. */
export interface ParseSdk {
  messages: {
    parse(params: ExtractionRequest): PromiseLike<{
      stop_reason: string | null;
      parsed_output: unknown;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface Usage {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

export const zeroUsage = (): Usage => ({ calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 });

/**
 * An ExtractionClient for llmExtract that sends every request to `model` (whatever TRIALGUARD_LLM_MODEL
 * was at import time) and counts tokens. Overriding per request is what lets one run compare several
 * models; llm.ts reads its model once, when the module loads.
 */
export function meteredClient(sdk: ParseSdk, model: string, usage: Usage): ExtractionClient {
  return {
    messages: {
      parse: async (params) => {
        usage.calls += 1;
        try {
          const res = await sdk.messages.parse({ ...params, model });
          usage.inputTokens += res.usage.input_tokens;
          usage.outputTokens += res.usage.output_tokens;
          return res;
        } catch (err) {
          usage.errors += 1;
          throw err;
        }
      },
    },
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  const queue = items.map((item, index) => ({ item, index }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) out[job.index] = await fn(job.item, job.index);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---------- comparison ----------

export type LlmScope = 'all' | 'needed';

/**
 * Which emails get a model call. "all": every email that passes the relevance filter (gives an
 * LLM-only column). "needed": only those the pipeline would send (rules result incomplete), which is
 * what production pays for.
 */
export function emailsToCall(cases: readonly EmailCase[], scope: LlmScope): EmailCase[] {
  return cases.filter((c) => {
    const m = toEmailMessage(c);
    if (!isRelevantEmail(m.from, m.subject)) return false;
    return scope === 'all' || needsLlmExtraction(rulesExtract(m));
  });
}

export interface ApiLlm {
  llmExtract(email: EmailMessage, opts: { client: ExtractionClient }): Promise<EmailSignal | undefined>;
  mergeSignals(rules: EmailSignal | undefined, llm: EmailSignal | undefined): EmailSignal | undefined;
}

export interface ModelComparison {
  model: string;
  scope: LlmScope;
  usage: Usage;
  costUsd: number | undefined;
  /** Each email's own model result, before merging (only with scope "all"). */
  llmOnly?: EmailResult;
  /** What the pipeline stores: rules, with the LLM filling gaps where the rules result is incomplete. */
  rulesPlusLlm: EmailResult;
}

/**
 * Calls the model for the selected emails, then scores two systems from the same calls:
 *  - LLM only: the model's (policy-checked) signal for each email that passed the relevance filter;
 *  - rules + LLM: ingestEmail's logic in pipeline.ts, i.e. needsLlmExtraction gates mergeSignals.
 */
export async function compareModel(
  cases: readonly EmailCase[],
  opts: { model: string; scope: LlmScope; sdk: ParseSdk; api: ApiLlm; concurrency: number; onProgress?: (done: number, total: number) => void },
): Promise<ModelComparison> {
  const usage = zeroUsage();
  const client = meteredClient(opts.sdk, opts.model, usage);
  const targets = emailsToCall(cases, opts.scope);
  let done = 0;
  const results = await mapLimit(targets, opts.concurrency, async (c) => {
    const signal = await opts.api.llmExtract(toEmailMessage(c), { client });
    opts.onProgress?.(++done, targets.length);
    return [c.id, signal] as const;
  });
  const byId = new Map<string, EmailSignal | undefined>(results);

  const rulesPlusLlm = cases.map((c) => {
    const rules = rulesExtract(toEmailMessage(c));
    return byId.has(c.id) && needsLlmExtraction(rules) ? opts.api.mergeSignals(rules, byId.get(c.id)) : rules;
  });
  return {
    model: opts.model,
    scope: opts.scope,
    usage,
    costUsd: costUsd(opts.model, usage.inputTokens, usage.outputTokens),
    llmOnly: opts.scope === 'all' ? scoreEmails(cases, cases.map((c) => byId.get(c.id))) : undefined,
    rulesPlusLlm: scoreEmails(cases, rulesPlusLlm),
  };
}
