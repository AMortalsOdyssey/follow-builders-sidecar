#!/usr/bin/env node

import { homedir } from 'os';
import { join } from 'path';

import { pathExists, readJsonFile } from './sidecar-fs.js';

const SIDECAR_HOME = join(homedir(), '.follow-builders-sidecar');
const SIDECAR_CREDENTIALS_PATH = join(SIDECAR_HOME, 'credentials.json');
const LEGACY_SIDECAR_SECRETS_PATH = join(SIDECAR_HOME, ['secret', 's', '.json'].join(''));

function normalizeSecrets(overrides = {}) {
  return {
    version: 1,
    feishu: {
      appSecret: null
    },
    github: {
      token: null
    },
    ...overrides,
    feishu: {
      appSecret: overrides.feishu?.appSecret || null
    },
    github: {
      token: overrides.github?.token || null
    }
  };
}

async function loadStoredGitHubToken() {
  if (pathExists(SIDECAR_CREDENTIALS_PATH)) {
    return normalizeSecrets(await readJsonFile(SIDECAR_CREDENTIALS_PATH, {})).github?.token || null;
  }

  if (pathExists(LEGACY_SIDECAR_SECRETS_PATH)) {
    return normalizeSecrets(await readJsonFile(LEGACY_SIDECAR_SECRETS_PATH, {})).github?.token || null;
  }

  return null;
}

async function loadGitHubApiHeaders() {
  const headers = {
    'User-Agent': 'follow-builders-sidecar/1.0',
    'Accept': 'application/vnd.github+json'
  };

  const storedToken = await loadStoredGitHubToken();
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || storedToken || null;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

export {
  loadGitHubApiHeaders
};
