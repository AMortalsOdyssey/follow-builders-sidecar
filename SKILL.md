---
name: follow-builders-sidecar
description: OpenClaw-only sidecar for the original follow-builders skill. Use when the user wants to take over scheduling and delivery without modifying the upstream skill, configure digest delivery, inspect takeover status, or roll back to the original cron.
---

# Follow Builders Sidecar

This skill is the external delivery/scheduling layer for the original
`follow-builders` skill.

It does **not** patch the upstream repo. It only:

- imports the original config once
- disables the original digest cron
- creates and owns its own hourly cron
- checks upstream feed commits
- builds the digest
- delivers it through OpenClaw or Feishu card

## When to use this skill

Use this skill when the user asks to:

- install or take over from the original `follow-builders`
- switch digest delivery to the sidecar flow
- configure timezone / language / daily-vs-weekly / delivery driver
- check whether takeover worked
- disable sidecar and optionally restore the original cron

## Primary commands

### Takeover / setup

Run:

```bash
node /Users/tt/code/githubrepo/follow-builders-sidecar/scripts/sidecar-setup.js
```

Optional flags:

- `--driver openclaw_announce|feishu_card`
- `--channel <channel>`
- `--to <target>`
- `--account <accountId>`
- `--feishu-mode existing_account|direct_credentials`
- `--feishu-account <accountId>`
- `--feishu-app-id <appId>`
- `--feishu-app-secret <appSecret>`
- `--feishu-chat-id <chatId>`
- `--avatar-fallback-account <accountId>`

### Configure

Run:

```bash
node /Users/tt/code/githubrepo/follow-builders-sidecar/scripts/sidecar-configure.js ...
```

Common flags:

- `--language zh|en|bilingual`
- `--timezone <IANA timezone>`
- `--frequency daily|weekly`
- `--weekly-day monday|...|sunday`
- `--driver openclaw_announce|feishu_card`
- `--channel <channel>`
- `--to <target>`
- `--account <accountId>`
- `--feishu-mode existing_account|direct_credentials`
- `--feishu-account <accountId>`
- `--feishu-app-id <appId>`
- `--feishu-app-secret <appSecret>`
- `--feishu-chat-id <chatId>`

Important:

- After takeover, configuration belongs to the sidecar.
- Do not tell the user to keep changing the original skill's delivery time.
- If the user wants a different trigger window, tell them to edit the sidecar cron itself.

### Status

Run:

```bash
node /Users/tt/code/githubrepo/follow-builders-sidecar/scripts/sidecar-status.js
```

### Rollback

Run:

```bash
node /Users/tt/code/githubrepo/follow-builders-sidecar/scripts/sidecar-rollback.js --reenable-original
```

Use `--reenable-original` only when the user explicitly wants to restore the original cron.

## Manual test run

To test the pipeline without sending anything:

```bash
node /Users/tt/code/githubrepo/follow-builders-sidecar/scripts/run-sidecar.js --skip-delivery
```

## Delivery rules

- default driver is `openclaw_announce`
- optional driver is `feishu_card`
- feed freshness is based on upstream GitHub commit time
- only same-local-day commits are valid
- `daily`: one successful send per local day
- `weekly`: only on the configured weekday, one successful send per week

## Upstream compatibility rules

The upstream `follow-builders` skill may evolve beyond the current three feeds.

When working with this sidecar, always treat upstream evolution as a first-class concern:

1. Before changing sidecar compatibility logic, inspect the upstream `SKILL.md`.
2. Inspect the upstream repo root for all `feed-*.json` files, not just:
   - `feed-x.json`
   - `feed-podcasts.json`
   - `feed-blogs.json`
3. If a new upstream feed appears, do **not** silently ignore it.
4. First determine whether the new feed can be handled by:
   - an existing adapter
   - a generic pass-through adapter
   - or a new dedicated adapter that must be added
5. If the sidecar cannot safely interpret the new feed schema yet, explicitly surface that limitation to the user instead of pretending nothing changed.

Design intent:

- `SKILL.md` is for agent/operator understanding
- code-level adapter/registry logic is for runtime compatibility

Do not rely on prose alone for runtime support. A note in `SKILL.md` helps the agent understand what to inspect, but actual support for a new feed still requires code or schema-level compatibility logic.

## Safety rules

- Never modify the original `follow-builders` repo during normal operation
- Never silently re-enable the original cron unless the user asks for rollback
- If the original cron is found enabled again during runtime, disable it and keep the sidecar as source of truth
