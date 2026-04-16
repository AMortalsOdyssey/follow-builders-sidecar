#!/usr/bin/env node

import { fileURLToPath } from 'url';

import {
  discoverUpstreamFeedFiles,
  findOriginalCronJob,
  findSidecarCronJob,
  listCronJobs,
  loadSidecarConfig,
  loadSidecarState,
  log,
  summarizeFeedCompatibility
} from './sidecar-common.js';

async function main() {
  const [config, state, cronJobs] = await Promise.all([
    loadSidecarConfig(),
    loadSidecarState(),
    listCronJobs()
  ]);

  const originalJob = findOriginalCronJob(cronJobs, state.originalJobId);
  const sidecarJob = findSidecarCronJob(cronJobs, state.sidecarJobId);
  let upstreamFeeds = null;

  try {
    upstreamFeeds = summarizeFeedCompatibility(await discoverUpstreamFeedFiles(config.source));
  } catch (error) {
    upstreamFeeds = {
      discovered: [],
      supported: [],
      unsupported: [],
      warnings: [`Upstream feed discovery failed: ${error.message}`]
    };
  }

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    config,
    state,
    upstreamFeeds,
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
