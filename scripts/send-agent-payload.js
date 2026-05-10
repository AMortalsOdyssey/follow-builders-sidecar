#!/usr/bin/env node

import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import {
  REPO_DIR,
  SIDECAR_CONFIG_PATH,
  SIDECAR_STATE_PATH,
  dateKeyInTimeZone,
  loadSidecarConfig,
  loadSidecarState,
  log,
  nowIso,
  resolveScheduleWindow,
  saveSidecarState,
  withStateLock
} from './sidecar-common.js';
import { sendDigestPayloadThroughOpenClaw } from './send-openclaw-message.js';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FEISHU_SEND_SCRIPT = join(SCRIPT_DIR, 'send-feishu-card.js');
const DEFAULT_INPUT_JSON_PATH = '/tmp/follow-builders-sidecar-raw.json';
const DEFAULT_PAYLOAD_PATH = '/tmp/follow-builders-sidecar-payload.json';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    inputJsonPath: DEFAULT_INPUT_JSON_PATH,
    payloadPath: DEFAULT_PAYLOAD_PATH,
    skipDelivery: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--input-json':
        parsed.inputJsonPath = args[++index];
        break;
      case '--payload':
      case '--payload-file':
        parsed.payloadPath = args[++index];
        break;
      case '--skip-delivery':
        parsed.skipDelivery = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function sendFeishuCard(payloadPath, config) {
  const feishu = config.delivery?.feishu || {};
  const args = ['node', FEISHU_SEND_SCRIPT, '--file', payloadPath];

  if (config.delivery?.avatarFallbackAccountId) {
    args.push('--avatar-fallback-account', config.delivery.avatarFallbackAccountId);
  }
  if (config.delivery?.avatarUpload?.strategy) {
    args.push('--avatar-upload-strategy', config.delivery.avatarUpload.strategy);
  }
  if (config.delivery?.avatarUpload?.accountId) {
    args.push('--avatar-upload-account', config.delivery.avatarUpload.accountId);
  }
  if (config.delivery?.avatarUpload?.domain) {
    args.push('--avatar-upload-domain', config.delivery.avatarUpload.domain);
  }

  if (!feishu.accountId || !feishu.chatId) {
    if (feishu.mode !== 'direct_credentials' || !feishu.chatId) {
      throw new Error('Feishu card delivery requires chatId and a configured credential source');
    }
  }

  args.push('--mode', feishu.mode || 'openclaw_account');
  if (feishu.accountId) {
    args.push('--account', feishu.accountId);
  }
  args.push('--to', feishu.chatId);

  const { stdout } = await execFileAsync(args[0], args.slice(1), {
    cwd: REPO_DIR,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180000
  });

  return stdout.trim() ? JSON.parse(stdout.trim()) : { status: 'ok' };
}

async function deliverPayload(payloadPath, payload, config) {
  if (config.delivery?.driver === 'feishu_card') {
    return sendFeishuCard(payloadPath, config);
  }
  return sendDigestPayloadThroughOpenClaw(payload, {
    ...(config.delivery?.openclaw || {})
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadSidecarConfig();
  const prepared = JSON.parse(await readFile(args.inputJsonPath, 'utf-8'));
  const payload = JSON.parse(await readFile(args.payloadPath, 'utf-8'));
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('Payload must contain a non-empty items array');
  }

  const currentIso = nowIso();
  const schedule = resolveScheduleWindow(config, new Date(currentIso));
  const commit = prepared.sidecar?.latestSupportedCommit || prepared.sidecar?.latestOverallCommit || null;
  const feedFingerprint = prepared.sidecar?.feedFingerprint || null;
  const deliveryResult = args.skipDelivery
    ? { status: 'dry_run' }
    : await deliverPayload(args.payloadPath, payload, config);

  await withStateLock(async () => {
    const state = await loadSidecarState();
    state.lastCheckedAt = currentIso;
    state.lastFeedCompatibility = prepared.sidecar?.upstreamFeeds || state.lastFeedCompatibility || null;
    state.lastCompatibilityWarnings = prepared.sidecar?.warnings || [];
    state.lastEvaluatedKey = schedule.key;
    state.lastEvaluatedCommitSha = commit?.sha || null;
    state.lastEvaluatedOutcome = args.skipDelivery ? 'agent_native_dry_run' : 'success';
    state.lastFeedFingerprint = feedFingerprint;
    if (commit?.committedAt) {
      state.lastObservedCommit = {
        sha: commit.sha,
        committedAt: commit.committedAt,
        subject: commit.subject,
        date: dateKeyInTimeZone(commit.committedAt, config.timezone)
      };
    }
    if (!args.skipDelivery) {
      state.lastDeliveredKey = schedule.key;
      state.lastDeliveredCommitSha = commit?.sha || feedFingerprint;
      state.lastSuccessAt = currentIso;
    }
    await saveSidecarState(state);
  });

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    mode: 'agent_native',
    delivered: !args.skipDelivery,
    delivery: deliveryResult,
    configPath: SIDECAR_CONFIG_PATH,
    statePath: SIDECAR_STATE_PATH,
    items: payload.items.length,
    commit
  })}\n`);
}

main().catch((error) => {
  log('error', 'Agent-native payload send failed', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});
