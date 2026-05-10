#!/usr/bin/env node

import { join } from 'path';
import { fileURLToPath } from 'url';

import {
  SCRIPT_DIR,
  SIDECAR_CREDENTIALS_PATH,
  buildDefaultConfig,
  buildSidecarCronMessage,
  loadSidecarConfig,
  loadSidecarState,
  log,
  normalizeFeishuDeliveryMode,
  normalizeWeeklyDay,
  runOpenClaw,
  saveSidecarConfig
} from './sidecar-common.js';
import {
  hasDirectFeishuCredentials,
  loadSidecarCredentials,
  mergeDirectFeishuCredentials,
  redactSidecarCredentials,
  saveSidecarCredentials
} from './sidecar-credentials.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--language':
        parsed.language = args[++index];
        break;
      case '--timezone':
        parsed.timezone = args[++index];
        break;
      case '--frequency':
        parsed.frequency = args[++index];
        break;
      case '--weekly-day':
        parsed.weeklyDay = args[++index];
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
      case '--model':
        parsed.model = args[++index];
        break;
      case '--generation-mode':
        parsed.generationMode = args[++index];
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

function inferFeishuMode(args, config) {
  if (args.feishuMode) {
    return normalizeFeishuDeliveryMode(args.feishuMode);
  }
  if (args.feishuAppId || args.feishuAppSecret) {
    return 'direct_credentials';
  }
  return normalizeFeishuDeliveryMode(config.delivery?.feishu?.mode);
}

function validateFeishuConfig(config, directCredentials) {
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

function normalizeGenerationMode(value, fallback = 'script_model') {
  if (value === 'agent_native') return 'agent_native';
  if (value === 'script_model') return 'script_model';
  return fallback === 'agent_native' ? 'agent_native' : 'script_model';
}

async function syncSidecarCronJob(config) {
  const state = await loadSidecarState();
  if (!state.sidecarJobId) return null;

  const scriptPath = join(SCRIPT_DIR, 'run-sidecar.js');
  const message = buildSidecarCronMessage(scriptPath, {
    generationMode: config.generation?.mode
  });
  const args = [
    'cron',
    'edit',
    state.sidecarJobId,
    '--message',
    message,
    '--timeout-seconds',
    '900'
  ];
  if (config.generation?.mode === 'agent_native' && config.model) {
    args.push('--model', config.model);
  }
  await runOpenClaw(args);
  return state.sidecarJobId;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadSidecarConfig();
  const existingCredentials = await loadSidecarCredentials();
  const feishuMode = inferFeishuMode(args, config);
  const nextCredentials = mergeDirectFeishuCredentials(existingCredentials, {
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

  const nextConfig = buildDefaultConfig({
    ...config,
    ...(args.language ? { language: args.language } : {}),
    ...(args.timezone ? { timezone: args.timezone } : {}),
    ...(args.frequency ? { frequency: args.frequency } : {}),
    ...(args.weeklyDay ? { weeklyDay: normalizeWeeklyDay(args.weeklyDay) } : {}),
    ...(args.model ? { model: args.model } : {}),
    generation: {
      ...config.generation,
      ...(args.generationMode ? { mode: normalizeGenerationMode(args.generationMode, config.generation?.mode) } : {})
    },
    delivery: {
      ...config.delivery,
      ...(args.driver ? { driver: args.driver } : {}),
      openclaw: {
        ...config.delivery.openclaw,
        ...(args.channel ? { channel: args.channel } : {}),
        ...(args.to ? { to: args.to } : {}),
        ...(args.accountId ? { accountId: args.accountId } : {})
      },
      feishu: {
        ...config.delivery.feishu,
        ...(feishuMode ? { mode: feishuMode } : {}),
        ...(args.feishuAccountId ? { accountId: args.feishuAccountId } : {}),
        ...(args.feishuChatId ? { chatId: args.feishuChatId } : {}),
        ...(args.feishuDomain ? { domain: args.feishuDomain } : {})
      },
      ...(args.avatarFallbackAccountId ? { avatarFallbackAccountId: args.avatarFallbackAccountId } : {}),
      avatarUpload: {
        ...config.delivery.avatarUpload,
        ...(args.avatarUploadStrategy ? { strategy: args.avatarUploadStrategy } : {}),
        ...(args.avatarUploadAccountId ? { accountId: args.avatarUploadAccountId } : {}),
        ...(args.avatarUploadDomain ? { domain: args.avatarUploadDomain } : {})
      }
    }
  });
  if (nextConfig.delivery?.feishu?.mode === 'direct_credentials' && !nextConfig.delivery?.feishu?.chatId) {
    nextConfig.delivery.feishu.chatId = nextCredentials.feishu.chatId || null;
  }
  if (nextConfig.delivery?.feishu?.mode === 'direct_credentials' && !nextConfig.delivery?.feishu?.domain) {
    nextConfig.delivery.feishu.domain = nextCredentials.feishu.domain || 'feishu';
  }
  if (nextConfig.delivery?.feishu?.mode === 'direct_credentials') {
    nextConfig.delivery.feishu.accountId = null;
  }

  validateFeishuConfig(nextConfig, nextCredentials);

  await saveSidecarConfig(nextConfig);
  if (hasDirectFeishuCredentials(nextCredentials)) {
    await saveSidecarCredentials(nextCredentials);
  }

  const sidecarJobId = await syncSidecarCronJob(nextConfig);

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    config: nextConfig,
    directCredentials: redactSidecarCredentials(nextCredentials),
    sidecarJobId
  })}\n`);
}

const IS_ENTRYPOINT = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (IS_ENTRYPOINT) {
  main().catch((error) => {
    log('error', 'Sidecar configure failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
}
