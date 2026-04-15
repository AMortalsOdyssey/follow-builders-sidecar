#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';

import { buildPreparedDigest, loadConfig, loadPrompts } from './prepare-digest.js';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(SCRIPT_DIR, '..');
const RUN_SCRIPT = join(SCRIPT_DIR, 'run-feishu-card-digest.js');
const USER_DIR = join(homedir(), '.follow-builders');
const DEFAULT_STATE_PATH = join(USER_DIR, 'feishu-card-delivery-state.json');
const DEFAULT_INPUT_JSON_PATH = '/tmp/follow-builders-scheduled-raw.json';
const DEFAULT_PAYLOAD_PATH = '/tmp/follow-builders-card-payload.json';
const DEFAULT_BRANCH = 'main';
const DEFAULT_MODEL = 'openai-codex/gpt-5.4';
const LEGACY_FEED_FILES = ['feed-x.json', 'feed-podcasts.json', 'feed-blogs.json'];
const FEED_FILE_PATTERN = /^feed-([a-z0-9-]+)\.json$/i;
const SUPPORTED_FEED_ADAPTERS = {
  x: {
    feedId: 'x',
    file: 'feed-x.json',
    outputKey: 'feedX'
  },
  podcasts: {
    feedId: 'podcasts',
    file: 'feed-podcasts.json',
    outputKey: 'feedPodcasts'
  },
  blogs: {
    feedId: 'blogs',
    file: 'feed-blogs.json',
    outputKey: 'feedBlogs'
  }
};

function log(level, message, context = {}) {
  const payload = { level, message };
  if (Object.keys(context).length > 0) {
    payload.context = context;
  }
  console.error(JSON.stringify(payload));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    accountId: 'main',
    branch: DEFAULT_BRANCH,
    commitRef: null,
    force: false,
    inputJsonPath: DEFAULT_INPUT_JSON_PATH,
    model: DEFAULT_MODEL,
    payloadPath: DEFAULT_PAYLOAD_PATH,
    repoDir: SKILL_DIR,
    skipSend: false,
    skipState: false,
    statePath: DEFAULT_STATE_PATH,
    timezone: null,
    to: null
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--account':
        parsed.accountId = args[++i];
        break;
      case '--branch':
        parsed.branch = args[++i];
        break;
      case '--commit':
        parsed.commitRef = args[++i];
        break;
      case '--force':
        parsed.force = true;
        break;
      case '--input-json-out':
        parsed.inputJsonPath = args[++i];
        break;
      case '--model':
        parsed.model = args[++i];
        break;
      case '--payload-out':
        parsed.payloadPath = args[++i];
        break;
      case '--repo-dir':
        parsed.repoDir = args[++i];
        break;
      case '--skip-send':
        parsed.skipSend = true;
        break;
      case '--skip-state':
        parsed.skipState = true;
        break;
      case '--state-file':
        parsed.statePath = args[++i];
        break;
      case '--timezone':
        parsed.timezone = args[++i];
        break;
      case '--to':
        parsed.to = args[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.skipSend && !parsed.to) {
    throw new Error('Missing required argument: --to');
  }

  return parsed;
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dateKeyInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value instanceof Date ? value : new Date(value));

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function runGit(repoDir, gitArgs) {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...gitArgs], {
    cwd: SCRIPT_DIR,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function fetchRemoteBranch(repoDir, branch) {
  log('info', 'Fetching remote branch for feed update check', {
    repoDir,
    branch
  });
  await runGit(repoDir, ['fetch', '--depth', '100', 'origin', branch]);
}

async function resolveCommitMeta(repoDir, ref) {
  const stdout = await runGit(repoDir, ['show', '-s', '--format=%H%x00%cI%x00%s', ref]);
  const [sha, committedAt, subject] = stdout.split('\0');
  if (!sha || !committedAt) {
    throw new Error(`Could not resolve commit metadata for ref: ${ref}`);
  }

  return {
    sha,
    committedAt,
    subject: subject || ''
  };
}

function describeFeedFile(file) {
  const normalized = collapseWhitespace(file);
  const match = normalized.match(FEED_FILE_PATTERN);
  if (!match) {
    return null;
  }

  const feedId = match[1].toLowerCase();
  const adapter = SUPPORTED_FEED_ADAPTERS[feedId] || null;

  return {
    file: normalized,
    feedId,
    supported: Boolean(adapter),
    outputKey: adapter?.outputKey || null,
    reason: adapter ? null : 'no_adapter'
  };
}

function buildFeedCompatibilityReport(feedFiles, warnings = []) {
  const all = [...new Set(feedFiles)]
    .map((file) => describeFeedFile(file))
    .filter(Boolean)
    .sort((left, right) => left.file.localeCompare(right.file));
  const supported = all.filter((entry) => entry.supported);
  const unsupported = all.filter((entry) => !entry.supported);

  return {
    all,
    supported,
    unsupported,
    supportedFiles: supported.map((entry) => entry.file),
    unsupportedFiles: unsupported.map((entry) => entry.file),
    warnings
  };
}

function summarizeFeedCompatibility(report) {
  return {
    discovered: report.all.map((entry) => ({
      feedId: entry.feedId,
      file: entry.file,
      supported: entry.supported
    })),
    supported: report.supported.map((entry) => ({
      feedId: entry.feedId,
      file: entry.file
    })),
    unsupported: report.unsupported.map((entry) => ({
      feedId: entry.feedId,
      file: entry.file,
      reason: entry.reason || 'no_adapter'
    })),
    warnings: [...(report.warnings || [])]
  };
}

async function discoverFeedFilesInRef(repoDir, ref) {
  try {
    const stdout = await runGit(repoDir, ['ls-tree', '-r', '--name-only', ref]);
    const feedFiles = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => FEED_FILE_PATTERN.test(line));

    if (feedFiles.length > 0) {
      return buildFeedCompatibilityReport(feedFiles);
    }
  } catch (error) {
    return buildFeedCompatibilityReport(LEGACY_FEED_FILES, [
      `Dynamic feed discovery failed for ${ref}: ${error.message}`,
      'Falling back to legacy feed list.'
    ]);
  }

  return buildFeedCompatibilityReport(LEGACY_FEED_FILES, [
    `No feed-*.json files were discovered in ${ref}.`,
    'Falling back to legacy feed list.'
  ]);
}

async function resolveLatestFeedCommit(repoDir, ref, feedFiles = LEGACY_FEED_FILES) {
  const targetFiles = [...new Set(
    (Array.isArray(feedFiles) ? feedFiles : LEGACY_FEED_FILES)
      .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
      .filter(Boolean)
  )];

  if (targetFiles.length === 0) {
    throw new Error('No feed files were provided for commit discovery');
  }

  const stdout = await runGit(repoDir, [
    'log',
    ref,
    '-n',
    '1',
    '--format=%H%x00%cI%x00%s',
    '--',
    ...targetFiles
  ]);

  if (!stdout) {
    throw new Error('Could not find a feed update commit in fetched history');
  }

  const [sha, committedAt, subject] = stdout.split('\0');
  return {
    sha,
    committedAt,
    subject: subject || ''
  };
}

async function readJsonFromCommit(repoDir, ref, filePath) {
  const raw = await runGit(repoDir, ['show', `${ref}:${filePath}`]);
  return JSON.parse(raw);
}

async function loadFeedsFromCommit(repoDir, ref, feedCompatibility) {
  const loadedFeeds = {};

  await Promise.all(
    feedCompatibility.supported.map(async (entry) => {
      loadedFeeds[entry.outputKey] = await readJsonFromCommit(repoDir, ref, entry.file);
    })
  );

  return {
    feedX: loadedFeeds.feedX || null,
    feedPodcasts: loadedFeeds.feedPodcasts || null,
    feedBlogs: loadedFeeds.feedBlogs || null,
    loadedFeeds
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, days: {} };
  }

  const days = raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)
    ? raw.days
    : {};

  return {
    version: 1,
    lastCheckedAt: raw.lastCheckedAt || null,
    lastObservedCommit: raw.lastObservedCommit || null,
    lastFeedCompatibility: raw.lastFeedCompatibility || null,
    lastCompatibilityWarnings: Array.isArray(raw.lastCompatibilityWarnings)
      ? raw.lastCompatibilityWarnings
      : [],
    days
  };
}

async function ensureStateFile(statePath) {
  await mkdir(dirname(statePath), { recursive: true });
  if (!existsSync(statePath)) {
    await writeFile(statePath, JSON.stringify({ version: 1, days: {} }, null, 2));
  }
}

async function loadState(statePath) {
  const raw = await readFile(statePath, 'utf-8');
  return normalizeState(JSON.parse(raw));
}

async function saveState(statePath, state) {
  const dayKeys = Object.keys(state.days).sort();
  if (dayKeys.length > 31) {
    const keep = new Set(dayKeys.slice(-31));
    state.days = Object.fromEntries(
      Object.entries(state.days).filter(([day]) => keep.has(day))
    );
  }

  await writeFile(statePath, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isStaleLock(lockPath, staleMs) {
  try {
    const details = await stat(lockPath);
    return Date.now() - details.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function acquireLock(statePath) {
  const lockPath = `${statePath}.lock`;
  const staleMs = 15 * 60 * 1000;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        createdAt: nowIso()
      }, null, 2));

      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (await isStaleLock(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }

      await sleep(250 * (attempt + 1));
    }
  }

  throw new Error(`Could not acquire state lock: ${lockPath}`);
}

async function withStateLock(statePath, callback) {
  await ensureStateFile(statePath);
  const release = await acquireLock(statePath);

  try {
    return await callback();
  } finally {
    await release();
  }
}

async function runFeishuCardDigest(args) {
  const commandArgs = [
    RUN_SCRIPT,
    '--account',
    args.accountId,
    '--input-json',
    args.inputJsonPath,
    '--payload-out',
    args.payloadPath,
    '--model',
    args.model
  ];

  if (args.skipSend) {
    commandArgs.push('--skip-send');
  } else {
    commandArgs.push('--to', args.to);
  }

  log('info', 'Running Feishu card digest generator', {
    inputJsonPath: args.inputJsonPath,
    payloadPath: args.payloadPath,
    skipSend: args.skipSend
  });

  const { stdout } = await execFileAsync('node', commandArgs, {
    cwd: SCRIPT_DIR,
    maxBuffer: 16 * 1024 * 1024
  });

  const trimmed = stdout.trim();
  if (!trimmed) {
    return { status: 'ok' };
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return { status: 'ok', raw: trimmed };
  }
}

async function execute(args) {
  const configErrors = [];
  const config = await loadConfig(configErrors);
  const timezone = args.timezone || config.timezone || 'Asia/Shanghai';
  const today = dateKeyInTimeZone(new Date(), timezone);
  const currentIso = nowIso();
  const compatibilityWarnings = [];

  log('info', 'Scheduled digest check started', {
    timezone,
    today,
    skipState: args.skipState,
    force: args.force,
    commitRef: args.commitRef || null
  });

  let state = null;
  if (!args.skipState) {
    state = await loadState(args.statePath);
    state.lastCheckedAt = currentIso;

    const todayRecord = state.days[today];
    if (!args.force && todayRecord?.status === 'success') {
      await saveState(args.statePath, state);
      log('info', 'Skipping scheduled digest because delivery already succeeded today', {
        today,
        commitSha: todayRecord?.commit?.sha || null
      });
      return {
        status: 'skipped',
        reason: 'already_delivered_today',
        date: today,
        commitSha: todayRecord?.commit?.sha || null
      };
    }
  }

  const feedCompatibility = args.commitRef
    ? await discoverFeedFilesInRef(args.repoDir, args.commitRef)
    : null;

  if (!args.commitRef) {
    await fetchRemoteBranch(args.repoDir, args.branch);
  }

  const resolvedFeedCompatibility = feedCompatibility
    || await discoverFeedFilesInRef(args.repoDir, 'FETCH_HEAD');
  const feedCompatibilitySummary = summarizeFeedCompatibility(resolvedFeedCompatibility);

  if (resolvedFeedCompatibility.warnings?.length > 0) {
    compatibilityWarnings.push(...resolvedFeedCompatibility.warnings);
  }
  if (resolvedFeedCompatibility.unsupported.length > 0) {
    compatibilityWarnings.push(
      `Unsupported upstream feeds discovered: ${resolvedFeedCompatibility.unsupported.map((entry) => entry.file).join(', ')}`
    );
  }

  if (state) {
    state.lastFeedCompatibility = feedCompatibilitySummary;
    state.lastCompatibilityWarnings = [...compatibilityWarnings];
  }

  if (resolvedFeedCompatibility.supported.length === 0) {
    if (state) {
      state.days[today] = {
        ...(state.days[today] || {}),
        status: 'no_supported_feeds',
        checkedAt: currentIso,
        upstreamFeeds: feedCompatibilitySummary
      };
      await saveState(args.statePath, state);
    }

    return {
      status: 'skipped',
      reason: 'no_supported_feeds',
      date: today,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
  }

  const ref = args.commitRef || 'FETCH_HEAD';
  const latestOverallCommit = args.commitRef
    ? await resolveCommitMeta(args.repoDir, args.commitRef)
    : await resolveLatestFeedCommit(args.repoDir, ref, resolvedFeedCompatibility.all);
  const commit = args.commitRef
    ? latestOverallCommit
    : await resolveLatestFeedCommit(args.repoDir, ref, resolvedFeedCompatibility.supported);
  const latestUnsupportedCommit = (!args.commitRef && resolvedFeedCompatibility.unsupported.length > 0)
    ? await resolveLatestFeedCommit(args.repoDir, ref, resolvedFeedCompatibility.unsupported).catch(() => null)
    : null;

  const commitDate = dateKeyInTimeZone(commit.committedAt, timezone);
  const latestUnsupportedCommitDate = latestUnsupportedCommit
    ? dateKeyInTimeZone(latestUnsupportedCommit.committedAt, timezone)
    : null;

  if (state) {
    state.lastObservedCommit = {
      sha: commit.sha,
      committedAt: commit.committedAt,
      subject: commit.subject,
      date: commitDate
    };
  }

  if (
    !args.force
    && latestUnsupportedCommit
    && latestUnsupportedCommitDate === today
    && commitDate !== today
  ) {
    if (state) {
      state.days[today] = {
        ...(state.days[today] || {}),
        status: 'unsupported_feed_update_today',
        checkedAt: currentIso,
        latestCommit: {
          sha: latestUnsupportedCommit.sha,
          committedAt: latestUnsupportedCommit.committedAt,
          subject: latestUnsupportedCommit.subject,
          date: latestUnsupportedCommitDate,
          file: latestUnsupportedCommit.file
        },
        upstreamFeeds: feedCompatibilitySummary,
        warnings: compatibilityWarnings
      };
      await saveState(args.statePath, state);
    }

    log('info', 'Skipping scheduled digest because only unsupported feeds updated today', {
      today,
      latestUnsupportedCommit
    });
    return {
      status: 'skipped',
      reason: 'unsupported_feed_update_today',
      date: today,
      latestUnsupportedCommit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
  }

  if (!args.force && commitDate !== today) {
    if (state) {
      state.days[today] = {
        ...(state.days[today] || {}),
        status: 'no_update',
        checkedAt: currentIso,
        latestCommit: state.lastObservedCommit,
        latestOverallCommit,
        upstreamFeeds: feedCompatibilitySummary,
        warnings: compatibilityWarnings
      };
      await saveState(args.statePath, state);
    }

    log('info', 'Skipping scheduled digest because latest feed commit is not from today', {
      today,
      commitDate,
      commitSha: commit.sha
    });
    return {
      status: 'skipped',
      reason: 'no_update_today',
      date: today,
      latestCommit: {
        sha: commit.sha,
        committedAt: commit.committedAt,
        subject: commit.subject,
        date: commitDate
      },
      latestOverallCommit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
  }

  if (
    latestUnsupportedCommit
    && latestOverallCommit?.sha === latestUnsupportedCommit.sha
    && latestOverallCommit.sha !== commit.sha
    && latestUnsupportedCommitDate === today
  ) {
    compatibilityWarnings.push(
      `Latest upstream update today was for unsupported feed ${latestUnsupportedCommit.file}; delivering the latest supported feeds only.`
    );
  }
  if (state) {
    state.lastCompatibilityWarnings = [...compatibilityWarnings];
  }

  if (state) {
    state.days[today] = {
      ...(state.days[today] || {}),
      status: 'running',
      checkedAt: currentIso,
      commit: {
        sha: commit.sha,
        committedAt: commit.committedAt,
        subject: commit.subject,
        date: commitDate
      },
      latestOverallCommit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings
    };
    await saveState(args.statePath, state);
  }

  const { feedX, feedPodcasts, feedBlogs } = await loadFeedsFromCommit(
    args.repoDir,
    commit.sha,
    resolvedFeedCompatibility
  );
  const promptErrors = [...configErrors];
  const prompts = await loadPrompts(promptErrors);
  const prepared = buildPreparedDigest({
    config,
    feedX,
    feedPodcasts,
    feedBlogs,
    prompts,
    errors: promptErrors
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
  log('info', 'Prepared exact-commit digest JSON written', {
    inputJsonPath: args.inputJsonPath,
    commitSha: commit.sha,
    upstreamFeeds: feedCompatibilitySummary
  });

  try {
    const result = await runFeishuCardDigest(args);
    const deliveryStatus = args.skipSend
      ? 'dry_run'
      : (result?.status === 'skipped' ? 'no_relevant_sources' : 'success');

    if (state) {
      state.days[today] = {
        ...(state.days[today] || {}),
        status: deliveryStatus,
        checkedAt: currentIso,
        sentAt: deliveryStatus === 'success' ? nowIso() : null,
        commit: {
          sha: commit.sha,
          committedAt: commit.committedAt,
          subject: commit.subject,
          date: commitDate
        },
        payloadPath: args.payloadPath,
        result,
        latestOverallCommit,
        upstreamFeeds: feedCompatibilitySummary,
        warnings: compatibilityWarnings
      };
      await saveState(args.statePath, state);
    }

    log('info', 'Scheduled digest check completed', {
      commitSha: commit.sha,
      sent: deliveryStatus === 'success',
      resultStatus: result?.status || 'ok'
    });

    return {
      status: 'ok',
      date: today,
      commit: {
        sha: commit.sha,
        committedAt: commit.committedAt,
        subject: commit.subject,
        date: commitDate
      },
      latestOverallCommit,
      latestUnsupportedCommit,
      upstreamFeeds: feedCompatibilitySummary,
      warnings: compatibilityWarnings,
      result
    };
  } catch (error) {
    if (state) {
      state.days[today] = {
        ...(state.days[today] || {}),
        status: 'error',
        checkedAt: currentIso,
        failedAt: nowIso(),
        commit: {
          sha: commit.sha,
          committedAt: commit.committedAt,
          subject: commit.subject,
          date: commitDate
        },
        latestOverallCommit,
        upstreamFeeds: feedCompatibilitySummary,
        warnings: compatibilityWarnings,
        error: error.message
      };
      await saveState(args.statePath, state);
    }

    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const runner = args.skipState
    ? () => execute(args)
    : () => withStateLock(args.statePath, () => execute(args));

  const result = await runner();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  log('error', 'Scheduled digest check failed', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});
