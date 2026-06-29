# Samurai Agent

Samurai Agent is a local-first, GUI-first Personal Agent Workspace.

The backend treats the workspace filesystem as the durable source of truth for
Artifacts, Memory, Knowledge Wiki pages, Skills, and support files. SQLite is
used for indexes, history, status, audit records, rollback points, and runtime
diagnostics.

## What Is In Scope

- Chat-centered local agent runtime
- Agent Backend cassette selection
- Memory, Knowledge Wiki, Skill, and Skill support-file retrieval
- Context preview for reusable workspace context
- Gateway pairing, inbound-message routing, webhook, Slack, Telegram, LINE, and Email inbound adapters
- Policy, audit, activity inbox, rollback point creation, and rollback restore
- Local file, browser fallback, collection, automation, and external-send draft operations

Large GUI redesign work is intentionally separate from this backend foundation.

## Local Setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Default URLs:

- Web: `http://127.0.0.1:5173`
- API health: `http://127.0.0.1:4317/api/health`

## Environment

Provider secrets live in `.env`, not in Settings UI.

Common values:

```bash
SAMURAI_LLM_MODEL=gemini/gemini-3.5-flash
GEMINI_API_KEY=...
SAMURAI_BACKEND_DEFAULT=samurai-native
```

External Assist is optional and stays outside accepted Memory:

```bash
SAMURAI_EXTERNAL_ASSIST_URL=https://assist.example.test/hints
SAMURAI_EXTERNAL_ASSIST_TOKEN=...
SAMURAI_EXTERNAL_ASSIST_AUTH_HEADER=Authorization
SAMURAI_EXTERNAL_ASSIST_TIMEOUT_MS=5000
SAMURAI_EXTERNAL_ASSIST_FILE=/absolute/path/to/external-assist.json
SAMURAI_EXTERNAL_ASSIST_FILES=/absolute/path/to/a.json:/absolute/path/to/b.json
SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID=local-file-external-assist
SAMURAI_EXTERNAL_ASSIST_PROVIDER_IDS=release-assist,gateway-assist
SAMURAI_EXTERNAL_ASSIST_MAX_HINTS=5
```

Set `SAMURAI_EXTERNAL_ASSIST_URL` for an HTTP provider, or
`SAMURAI_EXTERNAL_ASSIST_FILE` for a local JSON/JSONL provider. Use
`SAMURAI_EXTERNAL_ASSIST_FILES` for multiple local JSON/JSONL providers, separated
by the platform path delimiter or commas. If `SAMURAI_EXTERNAL_ASSIST_URL` is set,
the HTTP provider wins. The HTTP provider receives POST JSON for `prefetch` and
`sync` and returns either `{ "hints": [...] }` or a direct hint array. Hints use
`summary` or `content`, plus optional `id`, `title`, `source_label`,
`source_uri`, and `confidence`. Local file records may also include `keywords`
for query matching.

Invalid External Assist env does not stop API startup. `/api/health` and the
`external_assist_config` field on `/api/settings` report the provider kind, safe
endpoint/file summary, token presence, warnings, and config errors without
exposing tokens. `pnpm doctor` includes the same state when the API is running.

External CLI backends are optional:

```bash
SAMURAI_CLAUDE_CODE_COMMAND=
SAMURAI_CODEX_COMMAND=
```

Use `pnpm run backend:external:verify` to inspect external backend status and
stream probe metadata without starting a real run. Add `-- --run` only when you
intentionally want to execute the configured external CLI. Add `-- --run
--confirm-external-effects --resume --require-configured --backend codex` when
you want the verifier to prove run -> native session id -> resume for a
specific configured backend.
Real `--run` verification may use authenticated external services, network, and
provider quota. In agent-managed environments, run it only after explicit human
approval for those effects.

External sends are dry-run by default. Set `SAMURAI_EXTERNAL_SEND_DISPATCH=true`
only when you intentionally want dispatch adapters to perform outbound effects.
When dispatch is enabled, webhook URL, Slack webhook/API, Telegram Bot API,
LINE Messaging API, and Email SMTP sends are recorded as `dispatched` on
success; non-2xx responses, fetch failures, or SMTP failures are recorded as
`failed` with redacted diagnostics.

```bash
SAMURAI_SLACK_BOT_TOKEN=
SAMURAI_TELEGRAM_BOT_TOKEN=
SAMURAI_LINE_CHANNEL_ACCESS_TOKEN=
SAMURAI_EMAIL_SMTP_HOST=
SAMURAI_EMAIL_FROM=
```

Email inbound can also poll an IMAP mailbox and route messages through the same
Gateway pairing/routing path as `/api/gateway/email/messages`:

```bash
SAMURAI_EMAIL_IMAP_HOST=
SAMURAI_EMAIL_IMAP_USER=
SAMURAI_EMAIL_IMAP_PASSWORD=
```

Provider-style Email webhooks are accepted at
`POST /api/gateway/email/provider-webhooks/:provider` for `postmark`,
`mailgun`, and `sendgrid` payload shapes. They are normalized into the same
Email Gateway path and remain pairing/routing controlled by the backend.
Provider-native verification is optional but supported: Postmark Basic Auth,
Mailgun webhook signatures, and SendGrid signed webhook headers are required
only when their env keys are set.

```bash
SAMURAI_EMAIL_POSTMARK_WEBHOOK_USERNAME=
SAMURAI_EMAIL_POSTMARK_WEBHOOK_PASSWORD=
SAMURAI_EMAIL_MAILGUN_SIGNING_KEY=
SAMURAI_EMAIL_SENDGRID_WEBHOOK_PUBLIC_KEY=
```

Slack, Telegram, and LINE inbound verification are optional but supported:

```bash
SAMURAI_SLACK_SIGNING_SECRET=
SAMURAI_TELEGRAM_WEBHOOK_SECRET=
SAMURAI_LINE_CHANNEL_SECRET=
```

When this is set, `POST /api/gateway/slack/events` requires valid
`X-Slack-Signature` and `X-Slack-Request-Timestamp` headers. The signing secret
is not written into Workspace records or API responses. Telegram checks
`X-Telegram-Bot-Api-Secret-Token`; LINE checks `X-Line-Signature`.

Sandbox executor checks are also dry by default:

```bash
pnpm run sandbox:verify -- --json
```

Add `-- --run --backend none` to execute the fixed local host probe. Docker,
SSH, and remote sandbox runs require `--confirm-external-effects`.

## Verification

```bash
pnpm run typecheck
pnpm test
pnpm --filter @samurai-agent/web run build
pnpm run i18n:check
pnpm doctor
CI=true pnpm run backend:release:verify
pnpm run backend:gateway:verify
pnpm run backend:external:verify
pnpm run backend:channels:verify
pnpm run sandbox:verify
```

`pnpm doctor` checks the workspace layout, SQLite database, provider env,
external backend env, sandbox executor environment, dependency state, runner
startup probes, API health, recent backend runs, and Gateway state.

`CI=true pnpm run backend:release:verify` runs the non-destructive backend release gate:
typecheck, full tests, i18n check, web build, doctor, public naming scan,
Gateway recovery on a temporary workspace, external channel readiness, external
backend dry status/probe, sandbox capability probe, and local host sandbox probe.
Real external backend runs,
Docker/SSH/remote sandbox runs, and real channel service E2E checks
remain manual gates that require explicit confirmation.
`pnpm run backend:gateway:verify -- --json` creates a temporary workspace and
verifies that expired Gateway pairings and acquired concurrency locks are only
previewed in dry-run mode, then repaired to `expired` when explicitly applied.
`GET /api/health.release.manual_gates` exposes those same manual gates as
read-only diagnostics for UI and doctor output; it does not start external
processes.
`GET /api/health.release.profiles` also distinguishes the non-destructive
`local_oss` release profile from the `production_ops` profile, which still
requires explicit manual gates for authenticated external backend runs,
external sandbox runs, and real Slack/Telegram/LINE/Email service E2E checks.

If the runner check warns on slow or timed-out `tsx_import` / `vitest_cli`
startup, warm up or refresh local dependencies before treating full typecheck or
Vitest results as authoritative.

## Project Docs

- `PRINCIPLES.md`: design principles and decision criteria
- `ARCHITECTURE.md`: backend architecture specification
- `PUBLIC_NAMING.md`: public naming rules
- `WEB_UI_DESIGN.md`: UI direction
- `plans/`: implementation plans and reviews

## Workspace Data

By default, local data is stored in `workspace-data/`.

Key directories:

- `artifacts/`: generated durable drafts and files
- `memory/`: Memory markdown files
- `wiki/`: Knowledge Wiki markdown pages
- `skills/`: Skill markdown and support files
- `rollback/`: rollback point snapshots

SQLite stores indexes and operational history in `workspace.sqlite`.
