#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { buildPreparedDigest } from './prepare-digest.js';
import { sendDigestPayloadThroughOpenClaw } from './send-openclaw-message.js';
import {
  DEFAULT_MODEL,
  REPO_DIR,
  SIDECAR_CONFIG_PATH,
  SIDECAR_SECRETS_PATH,
  SIDECAR_STATE_PATH,
  buildCronFingerprint,
  dateKeyInTimeZone,
  disableCronJob,
  discoverUpstreamFeedFiles,
  fetchCommitMetaBySha,
  fetchLatestRelevantCommit,
  findOriginalCronJob,
  findSidecarCronJob,
  listCronJobs,
  loadFeedsForCommit,
  loadSidecarConfig,
  loadSidecarPrompts,
  loadSidecarSecrets,
  loadSidecarState,
  log,
  nowIso,
  resolveScheduleWindow,
  saveSidecarState,
  summarizeFeedCompatibility,
  withStateLock
} from './sidecar-common.js';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CARD_PIPELINE_SCRIPT = join(SCRIPT_DIR, 'run-feishu-card-digest.js');
const FEISHU_SEND_SCRIPT = join(SCRIPT_DIR, 'send-feishu-card.js');
const DEFAULT_INPUT_JSON_PATH = '/tmp/follow-builders-sidecar-raw.json';
const DEFAULT_PAYLOAD_PATH = '/tmp/follow-builders-sidecar-payload.json';

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    commitSha: null,
    force: false,
    inputJsonPath: DEFAULT_INPUT_JSON_PATH,
    model: DEFAULT_MODEL,
    payloadPath: DEFAULT_PAYLOAD_PATH,
    skipDelivery: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--commit':
        parsed.commitSha = args[++index];
        break;
      case '--force':
        parsed.force = true;
        break;
      case '--input-json-out':
        parsed.inputJsonPath = args[++index];
        break;
      case '--model':
        parsed.model = args[++index];
        break;
      case '--payload-out':
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

function toPreparedConfig(config) {
  return {
    language: config.language,
    frequency: config.frequency,
    weeklyDay: config.weeklyDay,
    timezone: config.timezone,
    delivery: {
      method: 'stdout'
    }
  };
}

async function runCardPipeline({ inputJsonPath, payloadPath, model }) {
  const { stdout } = await execFileAsync('node', [
    CARD_PIPELINE_SCRIPT,
    '--input-json',
    inputJsonPath,
    '--payload-out',
    payloadPath,
    '--model',
    model,
    '--skip-send'
  ], {
    cwd: REPO_DIR,
    maxBuffer: 16 * 1024 * 1024
  });

  return stdout.trim() ? JSON.parse(stdout.trim()) : { status: 'ok' };
}

async function sendFeishuCard(payloadPath, config, secrets) {
  const feishu = config.delivery?.feishu || {};
  const args = ['node', FEISHU_SEND_SCRIPT, '--file', payloadPath];

  if (config.delivery?.avatarFallbackAccountId) {
    args.push('--avatar-fallback-account', config.delivery.avatarFallbackAccountId);
  }

  if (feishu.mode === 'direct_credentials') {
    if (!feishu.appId || !secrets?.feishu?.appSecret || !feishu.chatId) {
      throw new Error('Direct Feishu delivery requires appId, appSecret, and chatId');
    }
    args.push(
      '--app-id',
      feishu.appId,
      '--app-secret',
      secrets.feishu.appSecret,
      '--to',
      feishu.chatId
    );
    if (feishu.domain) {
      args.push('--domain', feishu.domain);
    }
  } else {
    if (!feishu.accountId || !feishu.chatId) {
      throw new Error('Existing-account Feishu delivery requires accountId and chatId');
    }
    args.push(
      '--account',
      feishu.accountId,
      '--to',
      feishu.chatId
    );
  }

  const { stdout } = await execFileAsync(args[0], args.slice(1), {
    cwd: REPO_DIR,
    maxBuffer: 16 * 1024 * 1024
  });

  return stdout.trim() ? JSON.parse(stdout.trim()) : { status: 'ok' };
}

async function execute(args) {
  const config = await loadSidecarConfig();
  const secrets = await loadSidecarSecrets();
  const state = await loadSidecarState();
  const currentIso = nowIso();
  const compatibilityWarnings = [];
  state.lastCheckedAt = currentIso;

  const jobs = await listCronJobs();
  const originalJob = findOriginalCronJob(jobs, state.originalJobId);
  const sidecarJob = findSidecarCronJob(jobs, state.sidecarJobId);
  const takeoverActive = Boolean(
    state.sidecarJobId
    || state.originalJobId
    || config.importedFrom?.importedAt
  );

  if (takeoverActive && originalJob) {
    state.originalJobId = originalJob.id;
    state.lastOriginalCronFingerprint = buildCronFingerprint(originalJob);
    if (originalJob.enabled) {
      log('info', 'Original follow-builders cron is enabled again, disabling it', {
        jobId: originalJob.id
      });
      await disableCronJob(originalJob.id);
    }
  }

  if (sidecarJob) {
    state.sidecarJobId = sidecarJob.id;
  }

  const feedCompatibility = await discoverUpstreamFeedFiles(config.source);
  const feedCompatibilitySummary = summarizeFeedCompatibility(feedCompatibility);
  state.lastFeedCompatibility = feedCompatibilitySummary;

  if (feedCompatibility.warnings?.length > 0) {
    compatibilityWarnings.push(...feedCompatibility.warnings);
  }
  if (feedCompatibility.unsupported.length > 0) {
    compatibilityWarnings.push(
      `Unsupported upstream feeds discovered: ${feedCompatibility.unsupported.map((entry) => entry.file).join(', ')}`
    );
  }
  state.lastCompatibilityWarnings = [...compatibilityWarnings];

  if (feedCompatibility.supported.length === 0) {
    state.lastEvaluatedOutcome = 'no_supported_feeds';
    await saveSidecarState(state);
    return {
      status: 'skipped',
      reason: 'no_supported_feeds',
      upstreamFeeds: feedCompatibilitySummary
    };
  }

  const schedule = resolveScheduleWindow(config, new Date());
  if (!args.force && !schedule.allowed) {
    state.lastEvaluatedKey = schedule.key;
    state.lastEvaluatedOutcome = 'weekly_not_due';
    await saveSidecarState(state);
    return {
      status: 'skipped',
      reason: 'weekly_not_due',
      weeklyDay: schedule.weeklyDay,
      weekday: schedule.weekday,
      date: schedule.today,
      upstreamFeeds: feedCompatibilitySummary
    };
  }

  if (!args.force && state.lastDeliveredKey === schedule.key) {
    await saveSidecarState(state);
    return {
      status: 'skipped',
      reason: 'already_delivered',
      key: state.lastDeliveredKey,
      commitSha: state.lastDeliveredCommitSha,
      upstreamFeeds: feedCompatibilitySummary
    };
  }

  const latestOverallCommit = args.commitSha
    ? await fetchCommitMetaBySha(args.commitSha, config.source)
    : await fetchLatestRelevantCommit(config.source, feedCompatibility.all);
  const commit = args.commitSha
    ? latestOverallCommit
    : await fetchLatestRelevantCommit(config.source, feedCompatibility.supported);
  const latestUnsupportedCommit = (!args.commitSha && feedCompatibility.unsupported.length > 0)
    ? await fetchLatestRelevantCommit(config.source, feedCompatibility.unsupported).catch(() => null)
    : null;
  const commitDate = dateKeyInTimeZone(commit.committedAt, config.timezone);
  state.lastObservedCommit = {
    sha: commit.sha,
    committedAt: commit.committedAt,
    subject: commit.subject,
    date: commitDate
  };

  const latestUnsupportedCommitDate = latestUnsupportedCommit
    ? dateKeyInTimeZone(latestUnsupportedCommit.committedAt, config.timezone)
    : null;

  if (
    !args.force
    && latestUnsupportedCommit
    && latestUnsupportedCommitDate === schedule.today
    && commitDate !== schedule.today
  ) {
    state.lastEvaluatedKey = schedule.key;
    state.lastEvaluatedCommitSha = latestUnsupportedCommit.sha;
    state.lastEvaluatedOutcome = 'unsupported_feed_update_today';
    await saveSidecarState(state);
    return {
      status: 'skipped',
      reason: 'unsupported_feed_update_today',
      today: schedule.today,
      latestUnsupportedCommit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
  }

  if (!args.force && commitDate !== schedule.today) {
    state.lastEvaluatedKey = schedule.key;
    state.lastEvaluatedCommitSha = commit.sha;
    state.lastEvaluatedOutcome = 'no_update_today';
    await saveSidecarState(state);
    return {
      status: 'skipped',
      reason: 'no_update_today',
      today: schedule.today,
      commitDate,
      commit,
      latestOverallCommit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
  }

  if (
    !args.force
    && state.lastEvaluatedKey === schedule.key
    && state.lastEvaluatedCommitSha === commit.sha
    && state.lastEvaluatedOutcome === 'no_relevant_sources'
  ) {
    await saveSidecarState(state);
    return {
      status: 'skipped',
      reason: 'same_commit_no_relevant_sources',
      commit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
  }

  if (
    latestUnsupportedCommit
    && latestOverallCommit?.sha === latestUnsupportedCommit.sha
    && latestOverallCommit.sha !== commit.sha
    && latestUnsupportedCommitDate === schedule.today
  ) {
    compatibilityWarnings.push(
      `Latest upstream update today was for unsupported feed ${latestUnsupportedCommit.file}; delivering the latest supported feeds only.`
    );
  }
  state.lastCompatibilityWarnings = [...compatibilityWarnings];

  const { feedX, feedPodcasts, feedBlogs } = await loadFeedsForCommit(
    commit.sha,
    config.source,
    feedCompatibility
  );
  const prompts = await loadSidecarPrompts();
  const prepared = buildPreparedDigest({
    config: toPreparedConfig(config),
    feedX,
    feedPodcasts,
    feedBlogs,
    prompts,
    errors: []
  });
  prepared.sidecar = {
    upstreamFeeds: feedCompatibilitySummary,
    latestOverallCommit,
    latestSupportedCommit: commit,
    latestUnsupportedCommit,
    warnings: compatibilityWarnings
  };
  if (compatibilityWarnings.length > 0) {
    prepared.errors = [...new Set([...(prepared.errors || []), ...compatibilityWarnings])];
  }

  await writeFile(args.inputJsonPath, JSON.stringify(prepared, null, 2));
  log('info', 'Prepared upstream commit snapshot for sidecar run', {
    commitSha: commit.sha,
    inputJsonPath: args.inputJsonPath
  });

  const pipelineResult = await runCardPipeline({
    inputJsonPath: args.inputJsonPath,
    payloadPath: args.payloadPath,
    model: args.model || config.model || DEFAULT_MODEL
  });

  if (pipelineResult?.status === 'skipped') {
    state.lastEvaluatedKey = schedule.key;
    state.lastEvaluatedCommitSha = commit.sha;
    state.lastEvaluatedOutcome = pipelineResult.reason || 'skipped';
    await saveSidecarState(state);
    return {
      status: 'skipped',
      reason: pipelineResult.reason || 'pipeline_skipped',
      commit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
  }

  const payload = JSON.parse(await readFile(args.payloadPath, 'utf-8'));
  let deliveryResult = { status: 'dry_run' };

  if (!args.skipDelivery) {
    if (config.delivery.driver === 'feishu_card') {
      deliveryResult = await sendFeishuCard(args.payloadPath, config, secrets);
    } else {
      deliveryResult = await sendDigestPayloadThroughOpenClaw(payload, {
        ...(config.delivery?.openclaw || {})
      });
    }
  }

  state.lastEvaluatedKey = schedule.key;
  state.lastEvaluatedCommitSha = commit.sha;
  state.lastEvaluatedOutcome = args.skipDelivery ? 'dry_run' : 'success';

  if (!args.skipDelivery) {
    state.lastDeliveredKey = schedule.key;
    state.lastDeliveredCommitSha = commit.sha;
    state.lastSuccessAt = currentIso;
  }

  await saveSidecarState(state);

  return {
    status: 'ok',
    configPath: SIDECAR_CONFIG_PATH,
    secretsPath: SIDECAR_SECRETS_PATH,
    statePath: SIDECAR_STATE_PATH,
    commit,
    latestOverallCommit,
    latestUnsupportedCommit,
    delivered: !args.skipDelivery,
    delivery: deliveryResult,
    upstreamFeeds: feedCompatibilitySummary,
    warnings: compatibilityWarnings
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await withStateLock(() => execute(args));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const IS_ENTRYPOINT = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (IS_ENTRYPOINT) {
  main().catch(async (error) => {
    log('error', 'Sidecar runtime failed', {
      error: error.message,
      stack: error.stack
    });

    try {
      const state = await loadSidecarState();
      state.lastCheckedAt = nowIso();
      state.lastEvaluatedOutcome = 'error';
      await saveSidecarState(state);
    } catch {
      // best effort only
    }

    process.exit(1);
  });
}
