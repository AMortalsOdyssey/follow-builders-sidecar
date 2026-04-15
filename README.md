**English** | [中文](README.zh-CN.md)

# follow-builders-sidecar

`follow-builders-sidecar` is an OpenClaw-only companion skill for the original
[`follow-builders`](https://github.com/zarazhangrui/follow-builders) project.
It does not patch the upstream repo. Instead, it takes over scheduling and
delivery from the outside while continuing to consume the upstream public feeds.

## What it adds

- Independent hourly OpenClaw cron
- One-success-per-day or one-success-per-week dedupe
- Same-day-only upstream commit gating by timezone
- Original cron auto-disable if it gets re-enabled later
- Structured digest generation with model repair and fallback
- Quote tweet enrichment
- Podcast episode link repair
- Low-signal / low-value content filtering
- OpenClaw default delivery driver
- Optional Feishu interactive card delivery
- Feishu direct app credentials support
- Avatar upload fallback to the default OpenClaw Feishu account

## Repo layout

- `SKILL.md`: companion skill instructions for OpenClaw
- `scripts/sidecar-setup.js`: one-time takeover
- `scripts/sidecar-configure.js`: manage sidecar-owned config
- `scripts/sidecar-status.js`: inspect config, state, and cron linkage
- `scripts/sidecar-rollback.js`: disable sidecar job and optionally re-enable the original job
- `scripts/run-sidecar.js`: hourly runtime entrypoint

## Local state

Sidecar stores its own files under `~/.follow-builders-sidecar/`:

- `config.json`
- `state.json`
- `secrets.json`

The original skill remains untouched. Its config is imported once from
`~/.follow-builders/config.json` during takeover.

## Setup flow

1. Install the original `follow-builders` skill.
2. Install this sidecar skill.
3. Run takeover:

```bash
cd scripts
npm install
node sidecar-setup.js
```

What takeover does:

- imports the original config once
- finds the original OpenClaw digest cron
- records its job id
- disables the original job
- creates a new hourly sidecar cron
- writes sidecar config/state/secrets

## Delivery modes

### Default: `openclaw_announce`

The default driver reuses the original OpenClaw target:

- `channel`
- `to`
- optional `accountId`

The sidecar runtime sends through `openclaw message send`, so it does not rely
on cron-delivery side effects.

### Optional: `feishu_card`

Two Feishu modes are supported:

- `existing_account`: reuse an OpenClaw Feishu account id
- `direct_credentials`: store a dedicated `appId/appSecret/chatId`

If the chosen Feishu app cannot upload images, avatar upload falls back to the
configured default OpenClaw Feishu account.

## Runtime semantics

- cron runs every hour by default
- the latest upstream feed commit is checked via GitHub API
- commit time is converted into sidecar `timezone`
- only commits that land on the same local day are considered valid
- `daily`: one successful delivery max per local day
- `weekly`: only on the configured `weeklyDay`, and one successful delivery max per week
- later commits on the same day do not trigger another delivery once one send succeeded

If a user wants a different trigger window, they should edit the sidecar cron
itself. Sidecar does not auto-sync the original skill's `deliveryTime`.

## Useful commands

```bash
node scripts/sidecar-status.js
node scripts/sidecar-configure.js --driver feishu_card --feishu-mode existing_account --feishu-account follow_builders_group --feishu-chat-id oc_xxx
node scripts/run-sidecar.js --skip-delivery
node scripts/sidecar-rollback.js --reenable-original
```

## Notes

- v1 intentionally targets OpenClaw only
- v1 does not modify the upstream `follow-builders` repo
- upstream feed freshness is based on GitHub commit time, not local file mtime
