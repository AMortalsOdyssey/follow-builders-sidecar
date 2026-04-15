#!/usr/bin/env node

import { fileURLToPath } from 'url';

import {
  buildDefaultConfig,
  buildDefaultSecrets,
  loadSidecarConfig,
  loadSidecarSecrets,
  log,
  normalizeWeeklyDay,
  saveSidecarConfig,
  saveSidecarSecrets
} from './sidecar-common.js';

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
      case '--feishu-mode':
        parsed.feishuMode = args[++index];
        break;
      case '--feishu-account':
        parsed.feishuAccountId = args[++index];
        break;
      case '--feishu-app-id':
        parsed.feishuAppId = args[++index];
        break;
      case '--feishu-app-secret':
        parsed.feishuAppSecret = args[++index];
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
  const config = await loadSidecarConfig();
  const secrets = await loadSidecarSecrets();

  const nextConfig = buildDefaultConfig({
    ...config,
    ...(args.language ? { language: args.language } : {}),
    ...(args.timezone ? { timezone: args.timezone } : {}),
    ...(args.frequency ? { frequency: args.frequency } : {}),
    ...(args.weeklyDay ? { weeklyDay: normalizeWeeklyDay(args.weeklyDay) } : {}),
    ...(args.model ? { model: args.model } : {}),
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
        ...(args.feishuMode ? { mode: args.feishuMode } : {}),
        ...(args.feishuAccountId ? { accountId: args.feishuAccountId } : {}),
        ...(args.feishuAppId ? { appId: args.feishuAppId } : {}),
        ...(args.feishuChatId ? { chatId: args.feishuChatId } : {})
      },
      ...(args.avatarFallbackAccountId ? { avatarFallbackAccountId: args.avatarFallbackAccountId } : {})
    }
  });

  const nextSecrets = buildDefaultSecrets({
    ...secrets,
    feishu: {
      appSecret: args.feishuAppSecret || secrets.feishu?.appSecret || null
    }
  });

  await saveSidecarConfig(nextConfig);
  await saveSidecarSecrets(nextSecrets);

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    config: {
      ...nextConfig,
      delivery: {
        ...nextConfig.delivery,
        feishu: {
          ...nextConfig.delivery.feishu,
          appSecret: undefined
        }
      }
    },
    secretsStored: Boolean(nextSecrets.feishu?.appSecret)
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
