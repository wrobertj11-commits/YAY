import type { RouteDeps } from './shared.ts';
import * as account from './account.ts';
import * as admin from './admin.ts';
import * as alerts from './alerts.ts';
import * as auth from './auth.ts';
import * as billing from './billing.ts';
import * as cancel from './cancel.ts';
import * as concierge from './concierge.ts';
import * as connections from './connections.ts';
import * as forward from './forward.ts';
import * as health from './health.ts';
import * as items from './items.ts';
import * as notifications from './notifications.ts';
import * as plaid from './plaid.ts';
import * as privacy from './privacy.ts';

const MODULES = [health, auth, account, notifications, privacy, connections, plaid, items, cancel, concierge, forward, alerts, billing, admin];

export function registerRoutes(deps: RouteDeps): void {
  for (const m of MODULES) m.register(deps);
}
