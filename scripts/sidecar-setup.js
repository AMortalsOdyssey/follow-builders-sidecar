#!/usr/bin/env node

import { fileURLToPath } from 'url';

import {
  ORIGINAL_CONFIG_PATH,
  SIDECAR_CONFIG_PATH,
  SIDECAR_STATE_PATH,
  buildDefaultConfig,
  buildDefaultState,
  buildCronFingerprint,
  createSidecarCronJob,
  disableCronJob,
  ensureSidecarHome,
  findOriginalCronJob,
  inferOpenClawDeliveryFromJob,
  listCronJobs,
  loadOpenClawFeishuConfig,
  loadOriginalConfig,
  loadSidecarConfig,
  loadSidecarState,
  log,
  nowIso,
  saveSidecarConfig,
  saveSidecarState
} from './sidecar-common.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    force: false,
    driver: null,
    channel: null,
    to: null,
    accountId: null,
    feishuAccountId: null,
    feishuChatId: null,
    avatarFallbackAccountId: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--force':
        parsed.force = true;
        break;
      case '--driver':
        parsed.driver = args[++index];
        break;
      case '--channel':
        parsed.channel = args[++index];
        break;
      case '--to':
        parsed.to = args[++index];
        break;
      case '--account':
        parsed.accountId = args[++index];
        break;
      case '--feishu-account':
        parsed.feishuAccountId = args[++index];
        break;
      case '--feishu-chat-id':
        parsed.feishuChatId = args[++index];
        break;
      case '--avatar-fallback-account':
        parsed.avatarFallbackAccountId = args[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv);
  await ensureSidecarHome();

  const existingConfig = await loadSidecarConfig();
  const existingState = await loadSidecarState();
  const originalConfig = await loadOriginalConfig();
  const openclawFeishu = await loadOpenClawFeishuConfig();
  const cronJobs = await listCronJobs();
  const originalJob = findOriginalCronJob(cronJobs, existingState.originalJobId);
  const existingSidecarJob = cronJobs.find((job) => job.id === existingState.sidecarJobId);

  if (!args.force && existingState.sidecarJobId && existingSidecarJob) {
    process.stdout.write(`${JSON.stringify({
      status: 'ok',
      message: 'Sidecar already initialized',
      configPath: SIDECAR_CONFIG_PATH,
      statePath: SIDECAR_STATE_PATH,
      sidecarJobId: existingState.sidecarJobId
    })}\n`);
    return;
  }

  const importedDelivery = inferOpenClawDeliveryFromJob(originalJob);
  const configuredFeishuAccounts = Object.keys(openclawFeishu.accounts || {}).filter((id) => id !== 'default');
  const defaultFeishuAccount = openclawFeishu.defaultAccount || configuredFeishuAccounts[0] || null;
  const importedConfig = buildDefaultConfig({
    language: originalConfig?.language || existingConfig.language,
    timezone: originalConfig?.timezone || existingConfig.timezone,
    frequency: originalConfig?.frequency || existingConfig.frequency,
    weeklyDay: originalConfig?.weeklyDay || existingConfig.weeklyDay,
    model: existingConfig.model,
    delivery: {
      driver: args.driver || existingConfig.delivery.driver || 'openclaw_announce',
      openclaw: {
        channel: args.channel || importedDelivery.channel || existingConfig.delivery?.openclaw?.channel,
        to: args.to || importedDelivery.to || existingConfig.delivery?.openclaw?.to,
        accountId: args.accountId || importedDelivery.accountId || existingConfig.delivery?.openclaw?.accountId
      },
      feishu: {
        accountId: args.feishuAccountId || existingConfig.delivery?.feishu?.accountId || defaultFeishuAccount,
        chatId: args.feishuChatId || existingConfig.delivery?.feishu?.chatId,
        domain: existingConfig.delivery?.feishu?.domain || openclawFeishu.domain || 'feishu'
      },
      avatarFallbackAccountId: args.avatarFallbackAccountId
        || existingConfig.delivery?.avatarFallbackAccountId
        || defaultFeishuAccount
    },
    importedFrom: {
      originalConfigPath: originalConfig ? ORIGINAL_CONFIG_PATH : null,
      importedAt: nowIso()
    }
  });

  const nextState = buildDefaultState({
    originalJobId: originalJob?.id || existingState.originalJobId || null,
    lastOriginalCronFingerprint: buildCronFingerprint(originalJob)
  });

  if (originalJob?.enabled) {
    log('info', 'Disabling original follow-builders cron during takeover', {
      jobId: originalJob.id
    });
    await disableCronJob(originalJob.id);
  }

  const sidecarJob = await createSidecarCronJob({
    timeZone: importedConfig.timezone
  });
  nextState.sidecarJobId = sidecarJob.id;

  await saveSidecarConfig(importedConfig);
  await saveSidecarState(nextState);

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    configPath: SIDECAR_CONFIG_PATH,
    statePath: SIDECAR_STATE_PATH,
    originalJobId: originalJob?.id || null,
    sidecarJobId: sidecarJob.id,
    disabledOriginalJob: Boolean(originalJob?.enabled),
    deliveryDriver: importedConfig.delivery.driver
  })}\n`);
}

const IS_ENTRYPOINT = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (IS_ENTRYPOINT) {
  main().catch((error) => {
    log('error', 'Sidecar setup failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
}
