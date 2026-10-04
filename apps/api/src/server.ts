import { createServer } from 'node:http';
import { assertNodeVersion, assertProductionConfig, config } from './config.ts';
import { keys } from './crypto.ts';
import { createApp } from './app.ts';
import { startJobs } from './jobs.ts';
import { log, reportError } from './log.ts';
import { consoleNotifier } from './notify.ts';
import { defaultDeps } from './pipeline.ts';
import { Store } from './store.ts';

assertNodeVersion();
assertProductionConfig();
keys(); // fail at boot, not on first use, if the keyring is misconfigured

const store = new Store(config.dataFile);
const server = createServer(createApp(store, defaultDeps));
const stopJobs = config.runJobs ? startJobs(store, consoleNotifier, defaultDeps) : () => {};

process.on('unhandledRejection', (err) => reportError(err, { source: 'unhandledRejection' }));

server.listen(config.port, () => {
  log.info('api listening', { port: config.port, llm: config.llmEnabled, production: config.production });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopJobs();
    store.flush();
    server.close(() => process.exit(0));
  });
}
