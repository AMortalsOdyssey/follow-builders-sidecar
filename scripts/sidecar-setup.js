#!/usr/bin/env node

import { fileURLToPath } from 'url';

import {
  ORIGINAL_CONFIG_PATH,
  SIDECAR_CONFIG_PATH,
  SIDECAR_CREDENTIALS_PATH,
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
  normalizeFeishuDeliveryMode,
  nowIso,
  saveSidecarConfig,
  saveSidecarState
} from './sidecar-common.js';
import {
  hasDirectFeishuCredentials,
  loadSidecarCredentials,
  mergeDirectFeishuCredentials,
  saveSidecarCredentials
} from './sidecar-credentials.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    force: false,
    generationMode: null,
    driver: null,
    channel: null,
    to: null,
    accountId: null,
    feishuMode: null,
    feishuAccountId: null,
    feishuChatId: null,
    feishuAppId: null,
    feishuAppSecret: null,
    feishuDomain: null,
    avatarFallbackAccountId: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--force':
        parsed.force = true;
        break;
      case '--generation-mode':
        parsed.generationMode = args[++index];
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
      case '--feishu-mode':
        parsed.feishuMode = args[++index];
        break;
      case '--feishu-chat-id':
        parsed.feishuChatId = args[++index];
        break;
      case '--feishu-app-id':
        parsed.feishuAppId = args[++index];
        break;
      case '--feishu-app-secret':
        parsed.feishuAppSecret = args[++index];
        break;
      case '--feishu-domain':
        parsed.feishuDomain = args[++index];
        break;
      case '--avatar-fallback-account':
        parsed.avatarFallbackAccountId = args[++index];
        break;
      case '--avatar-upload-app-id':
        parsed.avatarUploadAppId = args[++index];
        break;
      case '--avatar-upload-app-secret':
        parsed.avatarUploadAppSecret = args[++index];
        break;
      case '--avatar-upload-domain':
        parsed.avatarUploadDomain = args[++index];
        break;
      case '--avatar-upload-account':
        parsed.avatarUploadAccountId = args[++index];
        break;
      case '--avatar-upload-strategy':
        parsed.avatarUploadStrategy = args[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function normalizeGenerationMode(value, fallback = 'script_model') {
  if (value === 'agent_native') return 'agent_native';
  if (value === 'script_model') return 'script_model';
  return fallback === 'agent_native' ? 'agent_native' : 'script_model';
}

function inferFeishuMode(args, existingConfig) {
  if (args.feishuMode) {
    return normalizeFeishuDeliveryMode(args.feishuMode);
  }

  if (args.feishuAppId || args.feishuAppSecret) {
    return 'direct_credentials';
  }

  return normalizeFeishuDeliveryMode(existingConfig.delivery?.feishu?.mode);
}

function validateFeishuSetup({ config, directCredentials }) {
  if (config.delivery?.driver !== 'feishu_card') {
    return;
  }

  if (!config.delivery?.feishu?.chatId) {
    throw new Error('Feishu card delivery requires chatId');
  }

  if (config.delivery?.feishu?.mode === 'direct_credentials') {
    if (!hasDirectFeishuCredentials(directCredentials)) {
      throw new Error(`Direct Feishu mode requires appId and appSecret in ${SIDECAR_CREDENTIALS_PATH}`);
    }
    return;
  }

  if (!config.delivery?.feishu?.accountId) {
    throw new Error('Feishu card delivery requires a Feishu accountId from OpenClaw');
  }
}

async function main() {
  const args = parseArgs(process.argv);
  await ensureSidecarHome();

  const existingConfig = await loadSidecarConfig();
  const existingState = await loadSidecarState();
  const existingCredentials = await loadSidecarCredentials();
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
  const feishuMode = inferFeishuMode(args, existingConfig);
  const nextDirectCredentials = mergeDirectFeishuCredentials(existingCredentials, {
    feishu: {
      ...(args.feishuAppId ? { appId: args.feishuAppId } : {}),
      ...(args.feishuAppSecret ? { appSecret: args.feishuAppSecret } : {}),
      ...(args.feishuChatId ? { chatId: args.feishuChatId } : {}),
      ...(args.feishuDomain ? { domain: args.feishuDomain } : {})
    },
    avatarFeishu: {
      ...(args.avatarUploadAppId ? { appId: args.avatarUploadAppId } : {}),
      ...(args.avatarUploadAppSecret ? { appSecret: args.avatarUploadAppSecret } : {}),
      ...(args.avatarUploadDomain ? { domain: args.avatarUploadDomain } : {})
    }
  });
  const importedConfig = buildDefaultConfig({
    language: originalConfig?.language || existingConfig.language,
    timezone: originalConfig?.timezone || existingConfig.timezone,
    frequency: originalConfig?.frequency || existingConfig.frequency,
    weeklyDay: originalConfig?.weeklyDay || existingConfig.weeklyDay,
    model: existingConfig.model,
    generation: {
      mode: normalizeGenerationMode(args.generationMode, existingConfig.generation?.mode)
    },
    delivery: {
      driver: args.driver || existingConfig.delivery.driver || 'openclaw_announce',
      openclaw: {
        channel: args.channel || importedDelivery.channel || existingConfig.delivery?.openclaw?.channel,
        to: args.to || importedDelivery.to || existingConfig.delivery?.openclaw?.to,
        accountId: args.accountId || importedDelivery.accountId || existingConfig.delivery?.openclaw?.accountId
      },
      feishu: {
        mode: feishuMode,
        accountId: args.feishuAccountId || existingConfig.delivery?.feishu?.accountId || defaultFeishuAccount,
        chatId: args.feishuChatId
          || existingConfig.delivery?.feishu?.chatId
          || nextDirectCredentials.feishu.chatId,
        domain: args.feishuDomain
          || existingConfig.delivery?.feishu?.domain
          || nextDirectCredentials.feishu.domain
          || openclawFeishu.domain
          || 'feishu'
      },
      avatarFallbackAccountId: args.avatarFallbackAccountId
        || existingConfig.delivery?.avatarFallbackAccountId
        || defaultFeishuAccount,
      avatarUpload: {
        strategy: args.avatarUploadStrategy
          || existingConfig.delivery?.avatarUpload?.strategy
          || 'dedicated_credentials',
        accountId: args.avatarUploadAccountId
          || existingConfig.delivery?.avatarUpload?.accountId
          || null,
        domain: args.avatarUploadDomain
          || existingConfig.delivery?.avatarUpload?.domain
          || args.feishuDomain
          || nextDirectCredentials.avatarFeishu.domain
          || 'feishu'
      }
    },
    importedFrom: {
      originalConfigPath: originalConfig ? ORIGINAL_CONFIG_PATH : null,
      importedAt: nowIso()
    }
  });
  if (importedConfig.delivery?.feishu?.mode === 'direct_credentials') {
    importedConfig.delivery.feishu.accountId = null;
  }
  validateFeishuSetup({
    config: importedConfig,
    directCredentials: nextDirectCredentials
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
    timeZone: importedConfig.timezone,
    generationMode: importedConfig.generation?.mode,
    model: importedConfig.generation?.mode === 'agent_native' ? importedConfig.model : null
  });
  nextState.sidecarJobId = sidecarJob.id;

  await saveSidecarConfig(importedConfig);
  if (hasDirectFeishuCredentials(nextDirectCredentials)) {
    await saveSidecarCredentials(nextDirectCredentials);
  }
  await saveSidecarState(nextState);

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    configPath: SIDECAR_CONFIG_PATH,
    credentialsPath: SIDECAR_CREDENTIALS_PATH,
    statePath: SIDECAR_STATE_PATH,
    originalJobId: originalJob?.id || null,
    sidecarJobId: sidecarJob.id,
    disabledOriginalJob: Boolean(originalJob?.enabled),
    deliveryDriver: importedConfig.delivery.driver,
    feishuMode: importedConfig.delivery?.feishu?.mode || null
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
