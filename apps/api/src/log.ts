/**
 * Structured JSON logs with no personal data. Field values under sensitive keys are replaced,
 * and email addresses, bearer tokens and long digit runs (card/account numbers) are scrubbed
 * from every string, so a careless `log.info(..., { user })` can't leak.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEYS = new Set([
  'email', 'to', 'from', 'subject', 'body', 'text', 'html', 'description', 'name', 'token', 'accesstoken',
  'publictoken', 'sealedtoken', 'authorization', 'password', 'secret', 'cookie', 'forwardtoken', 'forwardingaddress',
  'ip', 'useragent', 'signedname', 'phone', 'address', 'proof', 'cancelproof', 'note', 'notes', 'pushtoken', 'devicetoken',
]);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_RE = /\b(Bearer\s+)[\w.~+/-]+=*/gi;
const DIGITS_RE = /\b\d{9,}\b/g;

export function scrub(value: string): string {
  return value.replace(EMAIL_RE, '[email]').replace(BEARER_RE, '$1[token]').replace(DIGITS_RE, '[digits]');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return scrub(value);
  if (value instanceof Error) return { name: value.name, message: scrub(value.message), stack: value.stack?.split('\n').slice(0, 6).map(scrub).join('\n') };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

type Sink = (line: string, level: Level) => void;

let sink: Sink = (line, level) => (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
let minLevel: Level = (process.env.LOG_LEVEL as Level) in LEVELS ? (process.env.LOG_LEVEL as Level) : process.env.NODE_ENV === 'test' ? 'warn' : 'info';

/** Tests capture output by swapping the sink. */
export function setLogSink(next: Sink, level: Level = minLevel): void {
  sink = next;
  minLevel = level;
}

function make(base: Fields): Logger {
  const emit = (level: Level, msg: string, fields?: Fields) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const record = { t: new Date().toISOString(), level, msg: scrub(msg), ...(redact({ ...base, ...fields }) as Fields) };
    sink(JSON.stringify(record), level);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => make({ ...base, ...fields }),
  };
}

export const log = make({});

/** Error tracking hook. Defaults to an error log; wire Sentry (or similar) here in production. */
type ErrorReporter = (err: unknown, context: Fields) => void;
let reporter: ErrorReporter = (err, context) => log.error('unhandled error', { ...context, err });

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next;
}

export function reportError(err: unknown, context: Fields = {}): void {
  try {
    reporter(err, context);
  } catch {
    // never let error reporting take the process down
  }
}
