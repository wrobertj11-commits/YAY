import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { startJobs } from './jobs.ts';
import { consoleNotifier } from './notify.ts';
import { defaultDeps } from './pipeline.ts';
import { Store } from './store.ts';

const store = new Store(config.dataFile);
const server = createServer(createApp(store, defaultDeps));
const stopJobs = config.runJobs ? startJobs(store, consoleNotifier, defaultDeps) : () => {};

server.listen(config.port, () => {
  console.log(`Trialguard API on http://localhost:${config.port}  (LLM extraction: ${config.llmEnabled ? 'on' : 'off'})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopJobs();
    store.flush();
    server.close(() => process.exit(0));
  });
}
