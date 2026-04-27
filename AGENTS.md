# AGENTS.md — orientation for any AI working in this repo

Read this first. It tells you what this project is, where the hard truths live, and what NOT to re-discover.

## What this is

**Kevin OS (kos)** — a personal operations AI that ingests Kevin's email, calendar, voice memos, LinkedIn DMs, Granola transcripts, Chrome-ext captures, and Notion changes, then classifies/resolves/surfaces them through a dashboard and Telegram bot. Deployed entirely on AWS (Lambda + RDS Postgres + EventBridge + Secrets Manager) with a Vercel-hosted Next.js dashboard.

## Read these in order before touching anything

1. **`.planning/HANDOVER-2026-04-26-PHASE-11-FRUSTRATION.md`** — most recent, most detailed, most honest state-of-the-world. Supersedes the earlier FULL-DAY handoff for integration-debug context.
2. **`.planning/STATE.md`** — current phase progress.
3. **`.planning/ROADMAP.md`** and **`.planning/REQUIREMENTS.md`** — project direction.
4. **`.planning/phases/11-*/11-CONTEXT.md`** — locked decisions D-01..D-14 for the current phase.
5. **`.planning/visual/mockup-v4.html`** — the LOCKED visual target. Do not modify it; it is read-only source of truth for any UI work. v4 supersedes v2 and v3.

## Project-local skills — LOAD THESE as needed

- **`.kilo/skills/kos-rds-ops/SKILL.md`** — admin DB access, VPC topology, role privileges, bastion fallback, canonical UUIDs.
- **`.kilo/skills/kos-aws-ops/SKILL.md`** — CDK stack map, Lambda names, CloudWatch debug loop, deploy gotchas, secrets list.
- **`.kilo/skills/kos-notion-gotchas/SKILL.md`** — the page-vs-database trap, the 4 indexer schedules, Notion schema coupling.

## Canonical facts that have bitten people (stop re-discovering)

- **AWS account:** `239541130189`, region `eu-north-1`.
- **Kevin owner_id:** `7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c`. Always hardcode a fallback — `KEVIN_OWNER_ID` env var is NOT reliably present on all Lambdas.
- **Dev EC2 CANNOT reach RDS directly.** Different VPCs, no peering. Use the one-shot in-VPC Lambda pattern (`scripts/admin-wipe-lambda/README.md`) or redeploy the bastion.
- **`kevin_context` Notion ID is a PAGE, not a database.** See `kos-notion-gotchas`.
- **Pollution guard** in `services/dashboard-api/src/seed-pollution-guard.ts` rejects the 10 historic seed-row titles. If seeding test data, bypass or rename.
- **IAM auth tokens expire after 15 min.** Every `pg.Pool` using RDS Proxy must set `password: async () => signer.getAuthToken()` — NEVER a captured string. Baked-in tokens cause 100% failure on every invocation past the 15-min mark of a warm Lambda. See `kos-rds-ops` skill.
- **`mockup-v4.html` is the visual target.** v4 is a refined **dark mission-control** (not a warm-paper reversion — AGENTS.md previously claimed warm-paper; that was about v2, which is obsolete). Palette: bg `#0b0d12`, surfaces `#11141b` / `#181c25` / `#20242f`, per-section muted accent colors (priority blue, brief amber, schedule teal, drafts violet, inbox pink, channels sage, entities terracotta). Fonts: **Inter Tight** (sans) + **IBM Plex Mono** (mono). Layout: 2-column 60/40, wide KPI strip, no third rail.

## Communication rules

- Never end a response with a question or open-ended offer. Give a result and stop.
- Never say "Great", "Certainly", "Okay", "Sure" as an opener.
- If work was requested, do it. Don't ask permission for obvious next steps.
- If you hit a real ambiguity, use the `question` tool with concrete options — not a vague "what do you want?".

## When something breaks in prod

Debug loop (see `kos-aws-ops` for full details):

1. `aws logs filter-log-events` over the last 30 min on every suspect Lambda log group, grep for `ERROR`.
2. Read the stack trace. It has `file:line`. Open that file. Don't grep.
3. Fix. Commit.
4. `cd packages/cdk && npx cdk deploy <STACK> --require-approval never`.
5. Wait 2 cron cycles. Re-check error counts. Expect zero.

## Never commit unless asked

Follow Kilo's default: make the change, show the diff, let the human choose to commit.
