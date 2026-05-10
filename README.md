**English** | [中文](README.zh-CN.md)

# follow-builders-sidecar

`follow-builders-sidecar` is an OpenClaw-only companion skill for the original
[`follow-builders`](https://github.com/zarazhangrui/follow-builders) project.
It does not patch the upstream repo. Instead, it takes over scheduling and
delivery from the outside while continuing to consume the upstream public feeds.

## Preview

This is the delivery experience the sidecar is designed for: a cleaner Feishu
interactive card that keeps the upstream signal intact while making it easier
to scan, click through, and share in a group chat.

![Feishu card preview](https://raw.githubusercontent.com/AMortalsOdyssey/follow-builders-sidecar/main/assets/feishu-card-preview.jpeg)

- configurable Feishu group-chat delivery
- real avatars instead of placeholder imagery
- clickable name and role that jump back to the source profile
- multiple updates from the same builder rendered within one card
- direct source links preserved for each item
- low-value / low-signal tweets filtered before delivery
- quoted tweets expanded with the original post context
- podcast links repaired to the exact episode or video page

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
- Dedicated avatar-upload Feishu app support for card images
- Avatar upload fallback to the default OpenClaw Feishu account

## Repo layout

- `assets/feishu-card-preview.jpeg`: Feishu card showcase screenshot
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
- `credentials.json` when direct Feishu app mode and/or dedicated avatar-upload app mode is enabled

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

When Feishu card delivery is desired, choose one of two modes during setup:

- `openclaw_account`: reuse a Feishu app already configured in OpenClaw
- `direct_credentials`: store a local-only `appId` / `appSecret` / `chatId` for this sidecar

What takeover does:

- imports the original config once
- finds the original OpenClaw digest cron
- records its job id
- disables the original job
- creates a new hourly sidecar cron
- writes sidecar config/state

## Delivery modes

### Default: `openclaw_announce`

The default driver reuses the original OpenClaw target:

- `channel`
- `to`
- optional `accountId`

The sidecar runtime sends through `openclaw message send`, so it does not rely
on cron-delivery side effects.

### Optional: `feishu_card`

Feishu card delivery supports two modes:

- `openclaw_account`: reuse an OpenClaw-configured Feishu account plus a target chat id
- `direct_credentials`: write a local-only Feishu `appId` / `appSecret` / `chatId` into `~/.follow-builders-sidecar/credentials.json`

If the chosen Feishu app cannot upload images, avatar upload can be routed through a dedicated avatar-upload Feishu app stored in `~/.follow-builders-sidecar/credentials.json` under `avatarFeishu`. If that path is not configured, avatar upload falls back to the configured default OpenClaw Feishu account.

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
node scripts/sidecar-configure.js --driver feishu_card --feishu-account follow_builders_group --feishu-chat-id oc_xxx
node scripts/sidecar-configure.js --driver feishu_card --feishu-mode direct_credentials --feishu-app-id cli_xxx --feishu-app-secret secret_xxx --feishu-chat-id oc_xxx
node scripts/sidecar-configure.js --avatar-upload-strategy dedicated_credentials --avatar-upload-app-id cli_xxx --avatar-upload-app-secret secret_xxx --avatar-upload-domain feishu
node scripts/run-sidecar.js --skip-delivery
node scripts/sidecar-rollback.js --reenable-original
```

## Dedicated avatar upload app

When card sending and image upload need different Feishu apps, configure them separately:

- `delivery.feishu`: the app used to send the interactive card
- `delivery.avatarUpload`: the strategy and optional OpenClaw account override for avatar image upload
- `credentials.json > avatarFeishu`: dedicated local-only `appId` / `appSecret` used only for uploading avatar images

Recommended strategy for this deployment:

- send card with the existing direct-delivery app
- upload avatar images with the dedicated avatar-upload app
- keep `img_url` as the final display fallback when image upload still fails

## Notes

- v1 intentionally targets OpenClaw only
- v1 does not modify the upstream `follow-builders` repo
- upstream feed freshness is based on GitHub commit time, not local file mtime

## License

MIT. See [LICENSE](LICENSE).

## Agent-native generation mode

By default, the sidecar uses `generation.mode = "script_model"`: the runtime script calls
`openclaw infer model run` with `config.model` to turn the prepared feed into a card
payload.

For persistent OpenClaw installs, you can instead use `generation.mode = "agent_native"`.
In this mode the hourly cron wakes an isolated OpenClaw agent. The scripts only prepare
the feed snapshot and send the final payload; the scheduled agent itself generates the
JSON payload with the cron job's configured model.

```bash
node scripts/sidecar-configure.js --generation-mode agent_native --model codex-5.5
```

The generated cron prompt is installation-local but not user-specific: it uses the
installed script paths, writes temporary files under `/tmp`, and then calls
`send-agent-payload.js` to deliver through the configured driver and mark the day as
sent. The state gate is unchanged: hourly checks continue, and a successful daily send
sets `lastDeliveredKey` so the same local day is not sent again unless you force a run.

Useful manual checks:

```bash
node scripts/run-sidecar.js --prepare-only --skip-delivery
node scripts/send-agent-payload.js --input-json /tmp/follow-builders-sidecar-raw.json --payload /tmp/follow-builders-sidecar-payload.json --skip-delivery
```
