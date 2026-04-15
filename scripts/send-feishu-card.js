#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');
const DEFAULT_CARD_TITLE = 'AI Builders Daily';

function log(level, message, context = {}) {
  const payload = { level, message };
  if (Object.keys(context).length > 0) {
    payload.context = context;
  }
  if (level === 'error') {
    if (context.error && context.stack) {
      console.error(JSON.stringify(payload));
      return;
    }
    console.error(JSON.stringify(payload));
    return;
  }
  console.error(JSON.stringify(payload));
}

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
    appId: null,
    appSecret: null,
    avatarFallbackAccount: null,
    domain: 'feishu',
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
      case '--app-id':
        parsed.appId = args[++i];
        break;
      case '--app-secret':
        parsed.appSecret = args[++i];
        break;
      case '--avatar-fallback-account':
        parsed.avatarFallbackAccount = args[++i];
        break;
      case '--domain':
        parsed.domain = args[++i];
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
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

function loadFeishuAccountFromConfig(feishu, accountId) {
  const resolvedAccountId = accountId || feishu.defaultAccount || 'main';
  const account = feishu.accounts[resolvedAccountId];
  if (!account?.appId || !account?.appSecret) {
    throw new Error(`Feishu account "${resolvedAccountId}" is missing app credentials`);
  }

  return {
    accountId: resolvedAccountId,
    appId: account.appId,
    appSecret: account.appSecret,
    domain: feishu.domain
  };
}

async function loadFeishuAccount(accountId) {
  const feishu = await loadFeishuConfig();
  return loadFeishuAccountFromConfig(feishu, accountId);
}

async function resolveFeishuCredentials(args) {
  if (args.appId || args.appSecret) {
    if (!args.appId || !args.appSecret) {
      throw new Error('Direct Feishu mode requires both --app-id and --app-secret');
    }
    return {
      accountId: args.accountId || 'direct',
      appId: args.appId,
      appSecret: args.appSecret,
      domain: args.domain || 'feishu'
    };
  }

  return loadFeishuAccount(args.accountId);
}

function resolveApiBase(domain) {
  if (domain === 'lark') {
    return 'https://open.larksuite.com/open-apis';
  }
  if (typeof domain === 'string' && domain.startsWith('http')) {
    return `${domain.replace(/\/+$/, '')}/open-apis`;
  }
  return 'https://open.feishu.cn/open-apis';
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}: ${payload ? JSON.stringify(payload) : 'empty response'}`);
  }

  return payload;
}

async function getTenantToken(creds) {
  const apiBase = resolveApiBase(creds.domain);
  log('info', 'Requesting Feishu tenant token', { accountId: creds.accountId });
  const payload = await fetchJson(`${apiBase}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: creds.appId,
      app_secret: creds.appSecret
    })
  });

  if (payload?.code !== 0 || !payload?.tenant_access_token) {
    throw new Error(`Failed to get Feishu tenant token: ${payload?.msg || 'unknown error'}`);
  }

  log('info', 'Feishu tenant token acquired', { accountId: creds.accountId });
  return payload.tenant_access_token;
}

function clampItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(Boolean);
}

function escapeMarkdownText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function escapeBoldContent(text) {
  return escapeMarkdownText(text).replace(/\*/g, '\\*');
}

function buildTitleMarkdown(item) {
  const title = escapeBoldContent(item.headline || item.title || '原文');
  return `**${title}**`;
}

function normalizeHighlight(item) {
  if (!item) return null;
  if (typeof item === 'string') {
    return { label: '', detail: item };
  }
  const label = item.label || '';
  const detail = item.detail || item.text || '';
  if (!label && !detail) return null;
  return { label, detail };
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isInterpretiveSentence(text) {
  return /^(这意味着|意味着|值得注意的是|可以看出|说明了|背后的意思是|潜台词是|本质上|换句话说)/.test(collapseWhitespace(text));
}

function buildLegacyBodyFromHighlights(item) {
  const parts = [];
  const translation = collapseWhitespace(item.translation || item.subtitle || item.title_translation || '');
  if (translation) {
    parts.push(translation);
  }

  const highlightDetails = (Array.isArray(item.highlights) ? item.highlights : [])
    .map(normalizeHighlight)
    .filter(Boolean)
    .map((highlight) => collapseWhitespace(highlight.detail || ''))
    .filter((detail) => detail && !isInterpretiveSentence(detail));

  if (highlightDetails.length > 0) {
    parts.push(highlightDetails.join(' '));
  }

  return parts.join(' ');
}

function buildBodyMarkdown(item) {
  const body = collapseWhitespace(
    item.body
    || item.detail
    || item.summary_text
    || buildLegacyBodyFromHighlights(item)
  );
  if (!body) return '';
  return escapeMarkdownText(body);
}

function buildProfileMarkdown(item) {
  const profileUrl = item.profile_url || item.author_url || item.source_profile_url || item.source_url;
  const name = escapeBoldContent(item.person_name || item.name || 'Unknown Builder');
  const identity = escapeMarkdownText(item.person_identity || item.identity || item.role || item.source_label || 'AI Builder');
  const clickableName = profileUrl ? `[**${name}**](${profileUrl})` : `**${name}**`;
  const clickableIdentity = profileUrl ? `[${identity}](${profileUrl})` : identity;
  return `${clickableName}\n${clickableIdentity}`;
}

function buildMetaMarkdown(item) {
  const parts = [];
  if (item.source_label) parts.push(escapeMarkdownText(item.source_label));
  if (item.posted_at || item.published_at) parts.push(escapeMarkdownText(item.posted_at || item.published_at));
  return parts.join(' · ');
}

function buildProfileTextBlock(item) {
  const metaLine = buildMetaMarkdown(item);
  return [
    buildProfileMarkdown(item),
    metaLine
  ].filter(Boolean).join('\n');
}

function buildProfileElement(item, imageKey) {
  const profileContent = buildProfileTextBlock(item);

  if (!imageKey) {
    return {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: profileContent
      }
    };
  }

  return {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'default',
    horizontal_spacing: '12px',
    columns: [
      {
        tag: 'column',
        width: '56px',
        vertical_align: 'top',
        elements: [
          {
            tag: 'img',
            img_key: imageKey,
            alt: { tag: 'plain_text', content: item.person_name || item.name || 'avatar' },
            preview: false
          }
        ]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'top',
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: profileContent
            }
          }
        ]
      }
    ]
  };
}

function normalizeSourceLinksList(entries = [], fallbackUrl = null) {
  const links = [];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry) continue;
      if (typeof entry === 'string') {
        links.push({ label: '查看原文', url: entry });
        continue;
      }
      if (entry.url) {
        links.push({
          label: entry.label || '查看原文',
          url: entry.url
        });
      }
    }
  }

  if (links.length === 0 && fallbackUrl) {
    links.push({ label: '查看原文', url: fallbackUrl });
  }

  return links;
}

function normalizeSourceLinks(item) {
  return normalizeSourceLinksList(item.source_links, item.source_url || item.url);
}

function buildSourceLinksMarkdown(item) {
  const links = normalizeSourceLinks(item);
  if (links.length === 0) return '';

  if (links.length === 1) {
    return `[${escapeMarkdownText(links[0].label)}](${links[0].url})`;
  }

  return links
    .map((link, index) => {
      const label = link.label || `查看原文 ${index + 1}`;
      return `[${escapeMarkdownText(label)}](${link.url})`;
    })
    .join(' · ');
}

function normalizeSection(item) {
  if (!item || typeof item !== 'object') return null;
  const sourceLinks = normalizeSourceLinksList(item.source_links, item.source_url || item.url);
  const body = collapseWhitespace(
    item.body
    || item.detail
    || item.summary_text
    || buildLegacyBodyFromHighlights(item)
  );
  const headline = collapseWhitespace(item.headline || item.title || '');

  if (!headline && !body && sourceLinks.length === 0) return null;

  return {
    headline: headline || sourceLinks[0]?.label || '原文',
    body: body || '',
    source_links: sourceLinks
  };
}

function extractSections(item) {
  const sections = (Array.isArray(item.sections) ? item.sections : [])
    .map(normalizeSection)
    .filter(Boolean);

  if (sections.length > 0) {
    return sections;
  }

  const legacySection = normalizeSection(item);
  return legacySection ? [legacySection] : [];
}

async function fetchAvatarBuffer(item) {
  const avatarUrl = item.avatar_url || inferAvatarUrl(item);
  if (!avatarUrl) {
    log('warning', 'Skipping avatar fetch because no avatar URL is available', {
      person: item.person_name || item.name || 'unknown'
    });
    return null;
  }

  log('info', 'Fetching avatar', {
    person: item.person_name || item.name || 'unknown',
    avatarHost: safeHost(avatarUrl)
  });

  const response = await fetch(avatarUrl, {
    headers: {
      'User-Agent': 'follow-builders-feishu-card/1.0'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`Avatar fetch failed with status ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

function inferAvatarUrl(item) {
  if (item.avatar_url) return item.avatar_url;
  const handle = item.person_handle || item.handle;
  if (handle) {
    return `https://unavatar.io/x/${handle.replace(/^@/, '')}`;
  }
  return null;
}

async function cropAvatarToCircle(buffer, tempDir) {
  const sourcePath = join(tempDir, `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.img`);
  const outputPath = join(tempDir, `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'circle-avatar.py');

  await writeFile(sourcePath, buffer);
  await execFileAsync('python3', [scriptPath, sourcePath, outputPath, '88']);
  return readFile(outputPath);
}

async function uploadImage(token, creds, buffer) {
  const apiBase = resolveApiBase(creds.domain);
  log('info', 'Uploading avatar image to Feishu', { accountId: creds.accountId });

  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', new Blob([buffer], { type: 'image/png' }), 'avatar.png');

  const response = await fetch(`${apiBase}/im/v1/images`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });

  const payload = await response.json();
  if (!response.ok || payload?.code !== 0 || !payload?.data?.image_key) {
    throw new Error(`Feishu image upload failed: ${payload?.msg || response.statusText}`);
  }

  log('info', 'Avatar uploaded to Feishu', { imageKey: payload.data.image_key });
  return payload.data.image_key;
}

function isMissingImageUploadScopeError(error) {
  return /im:resource:upload|im:resource/i.test(String(error?.message || ''));
}

async function resolveAvatarUploadClient(primaryCreds, primaryToken, fallbackAccountId) {
  const feishu = await loadFeishuConfig();
  const defaultAccountId = fallbackAccountId || feishu.defaultAccount || 'main';

  if (primaryCreds.accountId === defaultAccountId) {
    return { creds: primaryCreds, token: primaryToken };
  }

  const fallbackCreds = loadFeishuAccountFromConfig(feishu, defaultAccountId);
  const fallbackToken = await getTenantToken(fallbackCreds);
  log('info', 'Falling back to default Feishu account for avatar upload', {
    sendAccountId: primaryCreds.accountId,
    avatarAccountId: fallbackCreds.accountId
  });
  return { creds: fallbackCreds, token: fallbackToken };
}

async function resolveAvatarKeys(items, token, creds, avatarFallbackAccount = null) {
  const tempDir = await mkdtemp(join(tmpdir(), 'follow-builders-card-'));
  const avatarKeys = new Map();
  let avatarClient = { creds, token };

  try {
    for (const item of items) {
      const itemKey = item.profile_url || item.source_url || item.person_handle || item.name;
      if (!itemKey) continue;
      try {
        const originalBuffer = await fetchAvatarBuffer(item);
        if (!originalBuffer) continue;
        const roundedBuffer = await cropAvatarToCircle(originalBuffer, tempDir);
        let imageKey;

        try {
          imageKey = await uploadImage(avatarClient.token, avatarClient.creds, roundedBuffer);
        } catch (error) {
          if (!isMissingImageUploadScopeError(error) || avatarClient.creds.accountId !== creds.accountId) {
            throw error;
          }

          avatarClient = await resolveAvatarUploadClient(creds, token, avatarFallbackAccount);
          imageKey = await uploadImage(avatarClient.token, avatarClient.creds, roundedBuffer);
        }

        avatarKeys.set(itemKey, imageKey);
      } catch (error) {
        log('warning', 'Avatar processing skipped for item', {
          person: item.person_name || item.name || 'unknown',
          error: error.message
        });
      }
    }
    return avatarKeys;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildCard(payload, avatarKeys) {
  const dateText = payload.date || new Date().toISOString().slice(0, 10);
  const title = payload.title || `${DEFAULT_CARD_TITLE} · ${dateText}`;
  const summary = payload.summary || payload.top_takeaway || payload.subtitle || '';
  const items = clampItems(payload.items);

  const elements = [];

  if (summary) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**今日主线**\n${escapeMarkdownText(summary)}`
      }
    });
  }

  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `以下为本次抓取到的全部更新，共 ${items.length} 个来源。`
    }
  });

  elements.push({ tag: 'hr' });

  items.forEach((item, index) => {
    const profileKey = item.profile_url || item.source_url || item.person_handle || item.name;
    const imageKey = avatarKeys.get(profileKey);
    const sections = extractSections(item);
    elements.push(buildProfileElement(item, imageKey));

    sections.forEach((section, sectionIndex) => {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: buildTitleMarkdown(section)
        }
      });

      const bodyMarkdown = buildBodyMarkdown(section);
      if (bodyMarkdown) {
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: bodyMarkdown
          }
        });
      }

      const sourceLinks = buildSourceLinksMarkdown(section);
      if (sourceLinks) {
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: sourceLinks
          }
        });
      }

      if (sectionIndex < sections.length - 1) {
        elements.push({ tag: 'hr' });
      }
    });

    if (index < items.length - 1) {
      elements.push({ tag: 'hr' });
    }
  });
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title
      },
      template: 'indigo'
    },
    body: {
      elements
    }
  };
}

async function sendCard(card, target, token, creds, receiveIdType) {
  const apiBase = resolveApiBase(creds.domain);
  log('info', 'Sending Feishu card', {
    accountId: creds.accountId,
    receiveIdType
  });

  const payload = await fetchJson(`${apiBase}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: target,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });

  if (payload?.code !== 0 || !payload?.data?.message_id) {
    throw new Error(`Feishu card send failed: ${payload?.msg || 'unknown error'}`);
  }

  log('info', 'Feishu card sent', { messageId: payload.data.message_id });
  return payload.data.message_id;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be a JSON object');
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('Payload.items must contain at least one item');
  }
}

async function main() {
  const args = parseArgs(process.argv);
  log('info', 'Feishu card sender started', {
    file: args.file || 'stdin',
    accountId: args.accountId || 'default',
    dryRun: Boolean(args.dryRunFile || args.printCard)
  });

  const payload = await readStructuredInput(args.file);
  validatePayload(payload);

  const creds = await resolveFeishuCredentials(args);
  const token = await getTenantToken(creds);
  const items = clampItems(payload.items);
  const avatarKeys = await resolveAvatarKeys(items, token, creds, args.avatarFallbackAccount);
  const card = buildCard(payload, avatarKeys);

  if (args.dryRunFile) {
    await writeFile(args.dryRunFile, JSON.stringify(card, null, 2));
    log('info', 'Card JSON written to dry-run file', { path: args.dryRunFile });
  }

  if (args.printCard) {
    process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
  }

  if (args.dryRunFile || args.printCard) {
    return;
  }

  if (!args.to) {
    throw new Error('Missing required argument: --to');
  }

  const receiveIdType = args.receiveIdType || detectReceiveIdType(args.to);
  const messageId = await sendCard(card, args.to, token, creds, receiveIdType);
  process.stdout.write(JSON.stringify({ status: 'ok', messageId }) + '\n');
}

main().catch((error) => {
  log('error', 'Feishu card sender failed', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});
