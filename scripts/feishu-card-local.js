#!/usr/bin/env node

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

function detectReceiveIdType(target) {
  if (!target) return 'open_id';
  if (target.startsWith('oc_')) return 'chat_id';
  if (target.startsWith('ou_')) return 'open_id';
  if (target.startsWith('on_')) return 'union_id';
  return 'open_id';
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    accountId: null,
    avatarFallbackAccount: null,
    file: null,
    dryRunFile: null,
    printCard: false,
    to: null,
    receiveIdType: null
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--file':
        parsed.file = args[++i];
        break;
      case '--account':
        parsed.accountId = args[++i];
        break;
      case '--avatar-fallback-account':
        parsed.avatarFallbackAccount = args[++i];
        break;
      case '--to':
        parsed.to = args[++i];
        break;
      case '--receive-id-type':
        parsed.receiveIdType = args[++i];
        break;
      case '--dry-run-file':
        parsed.dryRunFile = args[++i];
        break;
      case '--print-card':
        parsed.printCard = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readStructuredInput(filePath) {
  const raw = filePath
    ? await readFile(filePath, 'utf-8')
    : await readStdin();
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Input is not valid JSON: ${error.message}`);
  }
}

async function loadFeishuConfig() {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    throw new Error(`OpenClaw config not found: ${OPENCLAW_CONFIG_PATH}`);
  }

  const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);
  const feishu = config.channels?.feishu;
  if (!feishu?.accounts) {
    throw new Error('Feishu accounts are not configured in OpenClaw');
  }

  return feishu;
}

async function loadFeishuAccountFromConfig(feishu, accountId) {
  const configuredAccounts = Object.keys(feishu.accounts || {}).filter((id) => id !== 'default');
  const resolvedAccountId = accountId || feishu.defaultAccount || configuredAccounts[0] || null;
  if (!resolvedAccountId) {
    throw new Error('Could not resolve a Feishu account from OpenClaw');
  }

  const account = feishu.accounts[resolvedAccountId];
  const appId = account?.appId || null;
  const appSecret = account?.appSecret || null;
  const domain = account?.domain || feishu.domain || 'feishu';

  if (!appId || !appSecret) {
    throw new Error(`Feishu account "${resolvedAccountId}" is missing app credentials`);
  }

  return {
    accountId: resolvedAccountId,
    appId,
    appSecret,
    domain: domain || 'feishu'
  };
}

async function withAvatarTempDir(run) {
  const tempDir = await mkdtemp(join(tmpdir(), 'follow-builders-card-'));
  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function cropAvatarToCircle(buffer, tempDir) {
  const sourcePath = join(tempDir, `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.img`);
  const outputPath = join(tempDir, `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'circle-avatar.py');

  await writeFile(sourcePath, buffer);
  await execFileAsync('python3', [scriptPath, sourcePath, outputPath, '88']);
  return readFile(outputPath);
}

async function writeCardJson(filePath, card) {
  await writeFile(filePath, JSON.stringify(card, null, 2));
}

export {
  detectReceiveIdType,
  loadFeishuAccountFromConfig,
  loadFeishuConfig,
  parseArgs,
  readStructuredInput,
  withAvatarTempDir,
  cropAvatarToCircle,
  writeCardJson
};
