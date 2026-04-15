#!/usr/bin/env node

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, '..');
const SIDECAR_HOME = join(homedir(), '.follow-builders-sidecar');
const SIDECAR_CONFIG_PATH = join(SIDECAR_HOME, 'config.json');
const SIDECAR_STATE_PATH = join(SIDECAR_HOME, 'state.json');
const SIDECAR_SECRETS_PATH = join(SIDECAR_HOME, 'secrets.json');
const ORIGINAL_CONFIG_PATH = join(homedir(), '.follow-builders', 'config.json');
const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

const DEFAULT_MODEL = 'openai-codex/gpt-5.4';
const DEFAULT_CRON_EXPR = '0 * * * *';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_FREQUENCY = 'daily';
const DEFAULT_WEEKLY_DAY = 'monday';
const SIDECAR_JOB_NAME = 'Follow Builders Sidecar';
const FEED_FILES = ['feed-x.json', 'feed-podcasts.json', 'feed-blogs.json'];
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];
const UPSTREAM_DEFAULTS = {
  owner: 'zarazhangrui',
  repo: 'follow-builders',
  branch: 'main'
};

function log(level, message, context = {}) {
  const payload = { level, message };
  if (Object.keys(context).length > 0) {
    payload.context = context;
  }
  console.error(JSON.stringify(payload));
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (!match) {
      throw new Error('Could not parse JSON output');
    }
    return JSON.parse(match[1]);
  }
}

async function runCommand(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd || REPO_DIR,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function runOpenClaw(args) {
  return runCommand('openclaw', args);
}

async function runOpenClawJson(args) {
  const stdout = await runOpenClaw(args);
  return safeParseJson(stdout);
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function readJsonFile(path, fallbackValue) {
  if (!existsSync(path)) {
    return fallbackValue;
  }
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function writeJsonFile(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2));
}

function normalizeWeeklyDay(value) {
  const raw = collapseWhitespace(value).toLowerCase();
  const aliases = {
    mon: 'monday',
    tue: 'tuesday',
    tues: 'tuesday',
    wed: 'wednesday',
    thu: 'thursday',
    thur: 'thursday',
    thurs: 'thursday',
    fri: 'friday',
    sat: 'saturday',
    sun: 'sunday'
  };
  if (!raw) return DEFAULT_WEEKLY_DAY;
  if (aliases[raw]) return aliases[raw];
  return [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday'
  ].includes(raw) ? raw : DEFAULT_WEEKLY_DAY;
}

function buildDefaultConfig(overrides = {}) {
  const base = {
    version: 1,
    source: {
      ...UPSTREAM_DEFAULTS
    },
    language: DEFAULT_LANGUAGE,
    timezone: DEFAULT_TIMEZONE,
    frequency: DEFAULT_FREQUENCY,
    weeklyDay: DEFAULT_WEEKLY_DAY,
    model: DEFAULT_MODEL,
    delivery: {
      driver: 'openclaw_announce',
      openclaw: {
        channel: null,
        to: null,
        accountId: null
      },
      feishu: {
        mode: 'existing_account',
        accountId: null,
        appId: null,
        chatId: null,
        domain: 'feishu'
      },
      avatarFallbackAccountId: null
    },
    importedFrom: {
      originalConfigPath: ORIGINAL_CONFIG_PATH,
      importedAt: null
    }
  };

  const merged = {
    ...base,
    ...overrides,
    source: {
      ...base.source,
      ...(overrides.source || {})
    },
    delivery: {
      ...base.delivery,
      ...(overrides.delivery || {}),
      openclaw: {
        ...base.delivery.openclaw,
        ...(overrides.delivery?.openclaw || {})
      },
      feishu: {
        ...base.delivery.feishu,
        ...(overrides.delivery?.feishu || {})
      }
    },
    importedFrom: {
      ...base.importedFrom,
      ...(overrides.importedFrom || {})
    }
  };

  merged.frequency = merged.frequency === 'weekly' ? 'weekly' : 'daily';
  merged.weeklyDay = normalizeWeeklyDay(merged.weeklyDay);
  merged.language = ['en', 'zh', 'bilingual'].includes(merged.language)
    ? merged.language
    : DEFAULT_LANGUAGE;
  merged.delivery.driver = merged.delivery.driver === 'feishu_card'
    ? 'feishu_card'
    : 'openclaw_announce';
  merged.delivery.feishu.mode = merged.delivery.feishu.mode === 'direct_credentials'
    ? 'direct_credentials'
    : 'existing_account';
  return merged;
}

function buildDefaultState(overrides = {}) {
  return {
    version: 1,
    originalJobId: null,
    sidecarJobId: null,
    lastDeliveredKey: null,
    lastDeliveredCommitSha: null,
    lastSuccessAt: null,
    lastCheckedAt: null,
    lastOriginalCronFingerprint: null,
    lastObservedCommit: null,
    lastEvaluatedKey: null,
    lastEvaluatedCommitSha: null,
    lastEvaluatedOutcome: null,
    ...overrides
  };
}

function buildDefaultSecrets(overrides = {}) {
  return {
    version: 1,
    feishu: {
      appSecret: null
    },
    ...overrides,
    feishu: {
      appSecret: overrides.feishu?.appSecret || null
    }
  };
}

async function loadSidecarConfig() {
  return buildDefaultConfig(await readJsonFile(SIDECAR_CONFIG_PATH, {}));
}

async function saveSidecarConfig(config) {
  await writeJsonFile(SIDECAR_CONFIG_PATH, buildDefaultConfig(config));
}

async function loadSidecarState() {
  return buildDefaultState(await readJsonFile(SIDECAR_STATE_PATH, {}));
}

async function saveSidecarState(state) {
  await writeJsonFile(SIDECAR_STATE_PATH, buildDefaultState(state));
}

async function loadSidecarSecrets() {
  return buildDefaultSecrets(await readJsonFile(SIDECAR_SECRETS_PATH, {}));
}

async function saveSidecarSecrets(secrets) {
  await writeJsonFile(SIDECAR_SECRETS_PATH, buildDefaultSecrets(secrets));
}

async function ensureSidecarHome() {
  await ensureDir(SIDECAR_HOME);
}

async function loadOriginalConfig() {
  return readJsonFile(ORIGINAL_CONFIG_PATH, null);
}

async function loadOpenClawConfig() {
  return readJsonFile(OPENCLAW_CONFIG_PATH, null);
}

function extractLocalDateParts(value, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  });
  const parts = formatter.formatToParts(value instanceof Date ? value : new Date(value));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    weekday: String(lookup.weekday || '').toLowerCase()
  };
}

function dateKeyInTimeZone(value, timeZone) {
  const parts = extractLocalDateParts(value, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function weekdayInTimeZone(value, timeZone) {
  return extractLocalDateParts(value, timeZone).weekday;
}

function weekKeyInTimeZone(value, timeZone) {
  const parts = extractLocalDateParts(value, timeZone);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function resolveScheduleWindow(config, at = new Date()) {
  const timeZone = config.timezone || DEFAULT_TIMEZONE;
  const today = dateKeyInTimeZone(at, timeZone);
  const weekday = weekdayInTimeZone(at, timeZone);

  if (config.frequency === 'weekly') {
    const weeklyDay = normalizeWeeklyDay(config.weeklyDay);
    return {
      allowed: weekday === weeklyDay,
      frequency: 'weekly',
      weeklyDay,
      today,
      weekday,
      key: `weekly:${weekKeyInTimeZone(at, timeZone)}`
    };
  }

  return {
    allowed: true,
    frequency: 'daily',
    today,
    weekday,
    key: `daily:${today}`
  };
}

async function listCronJobs() {
  const payload = await runOpenClawJson(['cron', 'list', '--json']);
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

function extractCronMessage(job) {
  return collapseWhitespace(job?.payload?.message || job?.payload?.systemEvent || '');
}

function isOriginalFollowBuildersJob(job) {
  const message = extractCronMessage(job);
  const name = collapseWhitespace(job?.name).toLowerCase();
  return Boolean(
    message.includes('follow-builders/scripts/run-scheduled-feishu-card-digest.js')
    || message.includes('follow-builders/scripts/prepare-digest.js')
    || name === 'ai builders digest'
  );
}

function isSidecarJob(job) {
  const message = extractCronMessage(job);
  const name = collapseWhitespace(job?.name).toLowerCase();
  return Boolean(
    message.includes('follow-builders-sidecar/scripts/run-sidecar.js')
    || message.includes('/scripts/run-sidecar.js')
    || name === SIDECAR_JOB_NAME.toLowerCase()
  );
}

function findOriginalCronJob(jobs, preferredId = null) {
  if (preferredId) {
    const exact = jobs.find((job) => job.id === preferredId);
    if (exact) return exact;
  }
  return jobs.find((job) => isOriginalFollowBuildersJob(job)) || null;
}

function findSidecarCronJob(jobs, preferredId = null) {
  if (preferredId) {
    const exact = jobs.find((job) => job.id === preferredId);
    if (exact) return exact;
  }
  return jobs.find((job) => isSidecarJob(job)) || null;
}

function buildCronFingerprint(job) {
  if (!job) return null;
  return JSON.stringify({
    id: job.id || null,
    enabled: Boolean(job.enabled),
    name: job.name || null,
    schedule: job.schedule || null,
    delivery: job.delivery || null,
    updatedAtMs: job.updatedAtMs || null
  });
}

async function disableCronJob(jobId) {
  await runOpenClaw(['cron', 'disable', jobId]);
}

async function enableCronJob(jobId) {
  await runOpenClaw(['cron', 'enable', jobId]);
}

function buildSidecarCronMessage(scriptPath) {
  return [
    'Run exactly this command and do not generate the digest yourself:',
    `\`node ${scriptPath}\``,
    '',
    'If the command returns JSON with `status` equal to `ok` or `skipped`, reply with exactly `NO_REPLY`.',
    'If the command fails, inspect the error, fix the issue if possible, rerun once, and then reply with exactly `NO_REPLY`.'
  ].join('\n');
}

function extractJobId(payload) {
  return (
    payload?.job?.id
    || payload?.id
    || payload?.data?.id
    || payload?.result?.id
    || null
  );
}

async function createSidecarCronJob({ timeZone, scriptPath = join(REPO_DIR, 'scripts', 'run-sidecar.js') }) {
  const payload = await runOpenClawJson([
    'cron',
    'add',
    '--name',
    SIDECAR_JOB_NAME,
    '--cron',
    DEFAULT_CRON_EXPR,
    '--tz',
    timeZone || DEFAULT_TIMEZONE,
    '--session',
    'isolated',
    '--message',
    buildSidecarCronMessage(scriptPath),
    '--no-deliver',
    '--exact',
    '--timeout-seconds',
    '900',
    '--json'
  ]);

  return {
    id: extractJobId(payload),
    raw: payload
  };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed for ${url}: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed for ${url}: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  return response.text();
}

function buildGitHubApiHeaders() {
  return {
    'User-Agent': 'follow-builders-sidecar/1.0',
    'Accept': 'application/vnd.github+json'
  };
}

async function fetchLatestRelevantCommit(source = UPSTREAM_DEFAULTS) {
  const candidates = [];

  for (const file of FEED_FILES) {
    const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits?sha=${encodeURIComponent(source.branch)}&path=${encodeURIComponent(file)}&per_page=1`;
    const commits = await fetchJson(url, {
      headers: buildGitHubApiHeaders()
    });
    const commit = Array.isArray(commits) ? commits[0] : null;
    if (!commit?.sha || !commit?.commit?.committer?.date) {
      continue;
    }
    candidates.push({
      sha: commit.sha,
      committedAt: commit.commit.committer.date,
      subject: String(commit.commit.message || '').split('\n')[0].trim(),
      file
    });
  }

  if (candidates.length === 0) {
    throw new Error('Could not resolve latest upstream feed commit');
  }

  candidates.sort((a, b) => new Date(b.committedAt) - new Date(a.committedAt));
  return candidates[0];
}

async function fetchCommitMetaBySha(sha, source = UPSTREAM_DEFAULTS) {
  const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(sha)}`;
  const payload = await fetchJson(url, {
    headers: buildGitHubApiHeaders()
  });
  return {
    sha: payload.sha,
    committedAt: payload?.commit?.committer?.date,
    subject: String(payload?.commit?.message || '').split('\n')[0].trim()
  };
}

function buildRawFeedUrl(source, ref, file) {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${ref}/${file}`;
}

async function loadFeedsForCommit(sha, source = UPSTREAM_DEFAULTS) {
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJson(buildRawFeedUrl(source, sha, 'feed-x.json')),
    fetchJson(buildRawFeedUrl(source, sha, 'feed-podcasts.json')),
    fetchJson(buildRawFeedUrl(source, sha, 'feed-blogs.json'))
  ]);

  return { feedX, feedPodcasts, feedBlogs };
}

async function loadSidecarPrompts() {
  const prompts = {};
  const userPromptsDir = join(SIDECAR_HOME, 'prompts');
  const localPromptsDir = join(REPO_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    }
  }

  return prompts;
}

function normalizeOpenClawDelivery(value = {}) {
  return {
    channel: value.channel || null,
    to: value.to || null,
    accountId: value.accountId || value.account || null
  };
}

function inferOpenClawDeliveryFromJob(job) {
  if (!job) {
    return normalizeOpenClawDelivery();
  }
  return normalizeOpenClawDelivery({
    channel: job?.delivery?.channel,
    to: job?.delivery?.to,
    accountId: job?.delivery?.accountId || job?.accountId
  });
}

function redactSecrets(secrets) {
  return {
    version: secrets?.version || 1,
    feishu: {
      appSecret: secrets?.feishu?.appSecret ? '***' : null
    }
  };
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

async function acquireLock(lockPath) {
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

  throw new Error(`Could not acquire sidecar lock: ${lockPath}`);
}

async function withStateLock(callback, statePath = SIDECAR_STATE_PATH) {
  await ensureDir(dirname(statePath));
  const release = await acquireLock(`${statePath}.lock`);
  try {
    return await callback();
  } finally {
    await release();
  }
}

export {
  DEFAULT_MODEL,
  DEFAULT_TIMEZONE,
  FEED_FILES,
  OPENCLAW_CONFIG_PATH,
  ORIGINAL_CONFIG_PATH,
  REPO_DIR,
  SCRIPT_DIR,
  SIDECAR_CONFIG_PATH,
  SIDECAR_HOME,
  SIDECAR_JOB_NAME,
  SIDECAR_SECRETS_PATH,
  SIDECAR_STATE_PATH,
  UPSTREAM_DEFAULTS,
  buildCronFingerprint,
  buildDefaultConfig,
  buildDefaultSecrets,
  buildDefaultState,
  buildSidecarCronMessage,
  collapseWhitespace,
  createSidecarCronJob,
  dateKeyInTimeZone,
  disableCronJob,
  enableCronJob,
  ensureSidecarHome,
  fetchCommitMetaBySha,
  fetchJson,
  fetchLatestRelevantCommit,
  fetchText,
  findOriginalCronJob,
  findSidecarCronJob,
  inferOpenClawDeliveryFromJob,
  listCronJobs,
  loadFeedsForCommit,
  loadOpenClawConfig,
  loadOriginalConfig,
  loadSidecarConfig,
  loadSidecarPrompts,
  loadSidecarSecrets,
  loadSidecarState,
  log,
  normalizeOpenClawDelivery,
  normalizeWeeklyDay,
  nowIso,
  redactSecrets,
  resolveScheduleWindow,
  runCommand,
  runOpenClaw,
  runOpenClawJson,
  saveSidecarConfig,
  saveSidecarSecrets,
  saveSidecarState,
  safeParseJson,
  weekdayInTimeZone,
  withStateLock
};
