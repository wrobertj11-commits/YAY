import { MERCHANTS } from '@trialguard/core';
import { dispatchDueAlerts, type Notifier } from './notify.ts';
import { syncUser, type PipelineDeps } from './pipeline.ts';
import type { Store } from './store.ts';

/** Detection pipeline step 5: re-check every user daily so schedules, conversions and verifications stay current. */
export async function dailyRecheck(store: Store, deps: PipelineDeps): Promise<void> {
  for (const user of store.data.users) {
    try {
      await syncUser(store, user, deps);
    } catch (err) {
      console.error(`[jobs] daily re-check failed for ${user.id}`, err);
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

export function startJobs(store: Store, notifier: Notifier, deps: PipelineDeps): () => void {
  const minute = setInterval(() => void dispatchDueAlerts(store, notifier, deps.clock()), 60_000);
  const daily = setInterval(() => void dailyRecheck(store, deps), 24 * 3_600_000);
  void dispatchDueAlerts(store, notifier, deps.clock());
  return () => {
    clearInterval(minute);
    clearInterval(daily);
  };
}

export { dispatchDueAlerts };
