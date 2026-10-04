import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MERCHANTS } from '@trialguard/core';
import { config } from './config.ts';
import { JobLock } from './delivery/lock.ts';
import { dispatchOutbox, INSTANCE_ID, type DispatchOptions, type DispatchReport } from './delivery/outbox.ts';
import { log, reportError } from './log.ts';
import { describe, inc, setGauge } from './metrics.ts';
import { dispatchDueAlerts, type Notifier } from './notify.ts';
import { syncUser, type PipelineDeps } from './pipeline.ts';
import type { Store } from './store.ts';

/** Detection pipeline step 5: re-check every user daily so schedules, conversions and verifications stay current. */
export async function dailyRecheck(store: Store, deps: PipelineDeps): Promise<void> {
  for (const user of store.data.users) {
    try {
      await syncUser(store, user, deps);
    } catch (err) {
      reportError(err, { job: 'daily-recheck', userId: user.id });
    }
  }
}

/** Weekly check that cancel deep links still resolve (risk: merchants change cancel flows). */
export async function checkCancelLinks(fetchImpl: typeof fetch = fetch): Promise<{ merchantId: string; status: number | string }[]> {
  const broken: { merchantId: string; status: number | string }[] = [];
  for (const m of MERCHANTS) {
    try {
      const res = await fetchImpl(m.cancelUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      if (res.status >= 400 && res.status !== 401 && res.status !== 403 && res.status !== 405) broken.push({ merchantId: m.id, status: res.status });
    } catch (err) {
      broken.push({ merchantId: m.id, status: (err as Error).name });
    }
  }
  return broken;
}

// ---------- daily jobs ----------

export type DailyJobFn = (store: Store, now: Date) => unknown;
/** A bare function (its name labels logs and metrics) or an explicitly named job. */
export type DailyJob = DailyJobFn | { name: string; run: DailyJobFn };

const registeredDaily: { name: string; run: DailyJobFn }[] = [];

/**
 * Adds a job to the leader's daily run, e.g. `registerDailyJob('billing-sweep', sweepExpiredSubscriptions)`.
 * Call it at boot, before or after startJobs; it runs on the leader only, once a day.
 */
export function registerDailyJob(name: string, run: DailyJobFn): void {
  if (!registeredDaily.some((j) => j.name === name)) registeredDaily.push({ name, run });
}

const named = (j: DailyJob) => (typeof j === 'function' ? { name: j.name || 'anonymous', run: j } : j);

describe('jobs_runs_total', 'Background job runs on the leader, by job and result');
describe('jobs_leader', '1 when this instance holds the job lock');

// ---------- scheduler ----------

export interface JobOptions {
  /** Written into the lock and every alert claim. Default: host:pid:random. */
  instanceId?: string;
  /** Leader-election lock file (shared storage). null disables election: this process always runs the jobs. */
  lockFile?: string | null;
  /** A lock whose heartbeat is older than this is taken over. */
  staleAfterMs?: number;
  heartbeatMs?: number;
  /** How often the dispatcher looks for due alerts. */
  tickMs?: number;
  dailyMs?: number;
  /** Extra daily jobs for this run (in addition to the re-check and registerDailyJob ones). */
  daily?: DailyJob[];
  /** Outbox tuning (lease, attempts, backoff). */
  delivery?: Partial<Omit<DispatchOptions, 'clock' | 'instanceId'>>;
}

export interface TickReport {
  leader: boolean;
  dispatched?: DispatchReport;
  /** Names of daily jobs that ran in this tick. */
  daily?: string[];
}

export interface Scheduler {
  /** One scheduler step: become/stay leader, dispatch due alerts, run the daily jobs when a day has passed. */
  tick(): Promise<TickReport>;
  heartbeat(): boolean;
  isLeader(): boolean;
  stop(): void;
}

/**
 * When the daily jobs last ran, kept next to the lock so a restart or a new leader doesn't reset
 * the 24h clock (with frequent deploys an in-memory timer would never reach 24 hours).
 */
function dailyStateStore(file: string | undefined) {
  let memory: string | undefined;
  return {
    read(): string | undefined {
      if (!file) return memory;
      try {
        const v = (JSON.parse(readFileSync(file, 'utf8')) as { lastDailyAt?: unknown }).lastDailyAt;
        return typeof v === 'string' ? v : undefined;
      } catch {
        return undefined;
      }
    },
    write(at: string): void {
      memory = at;
      if (!file) return;
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ lastDailyAt: at }));
      renameSync(tmp, file);
    },
  };
}

export function createScheduler(store: Store, notifier: Notifier, deps: PipelineDeps, opts: JobOptions = {}): Scheduler {
  const instanceId = opts.instanceId ?? INSTANCE_ID;
  const lockFile = opts.lockFile === undefined ? config.jobLockFile : opts.lockFile;
  const lock = lockFile ? new JobLock({ file: lockFile, instanceId, staleMs: opts.staleAfterMs ?? 90_000, clock: deps.clock }) : undefined;
  const state = dailyStateStore(lockFile ? `${lockFile}.state.json` : undefined);
  const dailyMs = opts.dailyMs ?? 24 * 3_600_000;
  const extraDaily = (opts.daily ?? []).map(named);
  let dispatching = false;
  let dailyRunning = false;
  let stopped = false;

  const dailyJobs = () => [{ name: 'daily-recheck', run: () => dailyRecheck(store, deps) }, ...registeredDaily, ...extraDaily];

  async function runDispatch(): Promise<DispatchReport | undefined> {
    if (dispatching) return undefined;
    dispatching = true;
    try {
      return await dispatchOutbox(store, notifier, { ...opts.delivery, clock: deps.clock, instanceId });
    } finally {
      dispatching = false;
    }
  }

  function dailyDue(now: Date): boolean {
    const last = Date.parse(state.read() ?? '');
    if (!Number.isFinite(last)) {
      // First start (or an unreadable state file): begin the 24h clock instead of re-syncing every user at boot.
      state.write(now.toISOString());
      return false;
    }
    return now.getTime() - last >= dailyMs;
  }

  async function runDaily(now: Date): Promise<string[]> {
    dailyRunning = true;
    const ran: string[] = [];
    try {
      // Recorded before running: a crash mid-run waits for tomorrow instead of crash-looping a heavy re-sync.
      // Inside the try so a failed write (disk full, permissions) can't leave dailyRunning stuck on forever.
      state.write(now.toISOString());
      for (const job of dailyJobs()) {
        try {
          await job.run(store, now);
          inc('jobs_runs_total', { job: job.name, result: 'ok' });
        } catch (err) {
          inc('jobs_runs_total', { job: job.name, result: 'error' });
          reportError(err, { job: job.name });
        }
        ran.push(job.name);
      }
    } finally {
      dailyRunning = false;
    }
    return ran;
  }

  return {
    async tick() {
      if (stopped) return { leader: false };
      try {
        const leader = lock ? lock.tryAcquire() : true;
        if (!leader) return { leader: false };
        const now = deps.clock();
        const [dispatched, daily] = await Promise.all([runDispatch(), !dailyRunning && dailyDue(now) ? runDaily(now) : undefined]);
        return { leader: true, dispatched, daily };
      } catch (err) {
        reportError(err, { job: 'scheduler-tick' });
        return { leader: lock?.isLeader() ?? true };
      }
    },
    heartbeat() {
      if (!lock || stopped) return !stopped;
      try {
        return lock.isLeader() ? lock.heartbeat() : false;
      } catch (err) {
        reportError(err, { job: 'lock-heartbeat' });
        return false;
      }
    },
    isLeader: () => !stopped && (lock ? lock.isLeader() : true),
    stop() {
      stopped = true;
      try {
        lock?.release();
      } catch (err) {
        reportError(err, { job: 'lock-release' });
      }
    },
  };
}

/**
 * Starts the background jobs: alert dispatch every minute and the daily jobs (re-check + registered
 * ones), on the elected leader only. Returns a stop function that also releases the lock.
 *
 * Example: startJobs(store, notifier, deps, { daily: [sweepExpiredSubscriptions] })
 */
export function startJobs(store: Store, notifier: Notifier, deps: PipelineDeps, opts: JobOptions = {}): () => void {
  const scheduler = createScheduler(store, notifier, deps, opts);
  const tick = async () => {
    const r = await scheduler.tick();
    setGauge('jobs_leader', r.leader ? 1 : 0);
  };
  const ticker = setInterval(() => void tick(), opts.tickMs ?? 60_000);
  const beat = setInterval(() => void scheduler.heartbeat(), opts.heartbeatMs ?? 15_000);
  void tick();
  log.info('background jobs started', { instanceId: opts.instanceId ?? INSTANCE_ID, electing: opts.lockFile !== null });
  return () => {
    clearInterval(ticker);
    clearInterval(beat);
    scheduler.stop();
  };
}

export { dispatchDueAlerts };
