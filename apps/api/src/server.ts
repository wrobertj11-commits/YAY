import { createServer } from 'node:http';
import { assertNodeVersion, assertProductionConfig, config } from './config.ts';
import { keys } from './crypto.ts';
import { createApp } from './app.ts';
import { createDeliveryFromEnv } from './delivery/index.ts';
import { startJobs } from './jobs.ts';
import { log, reportError } from './log.ts';
import { defaultDeps } from './pipeline.ts';
import { Store } from './store.ts';

assertNodeVersion();
assertProductionConfig();
keys(); // fail at boot, not on first use, if the keyring is misconfigured

const store = new Store(config.dataFile);
// Push (APNs/FCM) and email (Postmark) from env; throws on half-configured channels. The same notifier
// serves the scheduler and the dispatch that follows a sync, so both go through the send-once outbox.
const delivery = createDeliveryFromEnv(store);
const deps = { ...defaultDeps, notifier: delivery.notifier };
const server = createServer(createApp(store, deps));
const stopJobs = config.runJobs ? startJobs(store, delivery.notifier, deps) : () => {};

process.on('unhandledRejection', (err) => reportError(err, { source: 'unhandledRejection' }));

server.listen(config.port, () => {
  log.info('api listening', { port: config.port, llm: config.llmEnabled, production: config.production });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopJobs();
    delivery.close();
    store.flush();
    server.close(() => process.exit(0));
  });
}
