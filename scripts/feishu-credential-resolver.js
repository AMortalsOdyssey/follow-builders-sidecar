#!/usr/bin/env node

import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  hasAvatarFeishuCredentials,
  hasDirectFeishuCredentials,
  loadSidecarCredentials
} from './sidecar-credentials.js';

const execFileAsync = promisify(execFile);

function collapseWhitespace(value) {
  return String(value || '').trim();
}

async function runOpenClaw(args) {
  const { stdout } = await execFileAsync('openclaw', args, {
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.trim();
}

async function runOpenClawJson(args) {
  const stdout = await runOpenClaw(args);
  return stdout ? JSON.parse(stdout) : null;
}

async function getOpenClawConfigValue(path, { json = false, fallback = null } = {}) {
  try {
    if (json) {
      return await runOpenClawJson(['config', 'get', path, '--json']);
    }
    const value = await runOpenClaw(['config', 'get', path]);
    return collapseWhitespace(value) || fallback;
  } catch {
    return fallback;
  }
}

async function loadOpenClawFeishuConfig() {
  const accounts = await getOpenClawConfigValue('channels.feishu.accounts', {
    json: true,
    fallback: null
  });
  const defaultAccount = await getOpenClawConfigValue('channels.feishu.defaultAccount', {
    fallback: null
  });
  const domain = await getOpenClawConfigValue('channels.feishu.domain', {
    fallback: 'feishu'
  });

  return {
    accounts: accounts && typeof accounts === 'object' ? accounts : {},
    defaultAccount,
    domain: domain || 'feishu'
  };
}

function resolveOpenClawAccountId(feishuConfig, requestedAccountId = null) {
  const configuredAccounts = Object.keys(feishuConfig.accounts || {}).filter((id) => id !== 'default');
  return requestedAccountId || feishuConfig.defaultAccount || configuredAccounts[0] || null;
}

function buildOpenClawCredentials(feishuConfig, accountId) {
  const resolvedAccountId = resolveOpenClawAccountId(feishuConfig, accountId);
  if (!resolvedAccountId) {
    throw new Error('Could not resolve a Feishu account from OpenClaw');
  }

  const account = feishuConfig.accounts?.[resolvedAccountId];
  const appId = collapseWhitespace(account?.appId);
  const appSecret = collapseWhitespace(account?.appSecret);
  const domain = collapseWhitespace(account?.domain) || feishuConfig.domain || 'feishu';

  if (!appId || !appSecret) {
    throw new Error(`Feishu account "${resolvedAccountId}" is missing app credentials`);
  }

  return {
    accountId: resolvedAccountId,
    appId,
    appSecret,
    domain
  };
}

async function resolveOpenClawFeishuCredentials(accountId = null) {
  const feishuConfig = await loadOpenClawFeishuConfig();
  return buildOpenClawCredentials(feishuConfig, accountId);
}

async function resolveDirectFeishuCredentials({ domain = null } = {}) {
  const stored = await loadSidecarCredentials();
  if (!hasDirectFeishuCredentials(stored)) {
    throw new Error('Direct Feishu credentials are not configured in ~/.follow-builders-sidecar/credentials.json');
  }

  return {
    accountId: 'direct_credentials',
    appId: stored.feishu.appId,
    appSecret: stored.feishu.appSecret,
    domain: collapseWhitespace(domain) || stored.feishu.domain || 'feishu'
  };
}

async function resolveAvatarUploadFeishuCredentials({ strategy = 'dedicated_credentials', fallbackMode = 'direct_credentials', fallbackAccountId = null, domain = null } = {}) {
  const stored = await loadSidecarCredentials();
  if (strategy === 'dedicated_credentials' && hasAvatarFeishuCredentials(stored)) {
    return {
      accountId: 'avatar_upload_credentials',
      appId: stored.avatarFeishu.appId,
      appSecret: stored.avatarFeishu.appSecret,
      domain: collapseWhitespace(domain) || stored.avatarFeishu.domain || 'feishu'
    };
  }

  if (strategy === 'openclaw_account') {
    return resolveOpenClawFeishuCredentials(fallbackAccountId);
  }

  if (fallbackMode === 'direct_credentials') {
    return resolveDirectFeishuCredentials({ domain });
  }
  return resolveOpenClawFeishuCredentials(fallbackAccountId);
}

async function resolveFeishuCredentials({ mode = 'openclaw_account', accountId = null, domain = null } = {}) {
  if (mode === 'direct_credentials') {
    return resolveDirectFeishuCredentials({ domain });
  }
  return resolveOpenClawFeishuCredentials(accountId);
}

export {
  buildOpenClawCredentials,
  loadOpenClawFeishuConfig,
  resolveAvatarUploadFeishuCredentials,
  resolveDirectFeishuCredentials,
  resolveFeishuCredentials,
  resolveOpenClawAccountId,
  resolveOpenClawFeishuCredentials
};
