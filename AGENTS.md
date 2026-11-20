## Hono CLI

Run `npx hono --help` first, and use the CLI instead of a dev server.

## Railway env vars: never overwrite `TRIGGER_SECRET_KEY`

The local `.env` holds a **development-only** Trigger.dev secret key (`tr_dev_sk_...`). Production has its own separate key already set on Railway. Pushing the local value would break production Trigger.dev runs.

- When syncing env vars to Railway (any `railway variable set`, bulk import of `.env`, or `railway variable edit`), **always exclude `TRIGGER_SECRET_KEY`**.
- Never run `railway variable set TRIGGER_SECRET_KEY=...`. To rotate it, do it in the Trigger.dev dashboard and set the new value directly in Railway.
- After any env sync, verify the production key is untouched with `railway variable list --service <service> --environment <env> --json`.

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.agents/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-chat-agent`, `trigger-authoring-tasks`, `trigger-chat-agent-advanced`, `trigger-cost-savings`, `trigger-getting-started`, `trigger-realtime-and-frontend`.
<!-- TRIGGER.DEV SKILLS END -->
