#!/usr/bin/env node

import { fileURLToPath } from 'url';

import {
  findOriginalCronJob,
  findSidecarCronJob,
  listCronJobs,
  loadSidecarConfig,
  loadSidecarSecrets,
  loadSidecarState,
  log,
  redactSecrets
} from './sidecar-common.js';

async function main() {
  const [config, secrets, state, cronJobs] = await Promise.all([
    loadSidecarConfig(),
    loadSidecarSecrets(),
    loadSidecarState(),
    listCronJobs()
  ]);

  const originalJob = findOriginalCronJob(cronJobs, state.originalJobId);
  const sidecarJob = findSidecarCronJob(cronJobs, state.sidecarJobId);

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    config,
    secrets: redactSecrets(secrets),
    state,
    jobs: {
      original: originalJob || null,
      sidecar: sidecarJob || null
    }
  }, null, 2)}\n`);
}

const IS_ENTRYPOINT = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (IS_ENTRYPOINT) {
  main().catch((error) => {
    log('error', 'Sidecar status failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
}
