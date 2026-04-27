# BOOT.md — OpenClaw KOS Operator boot sequence

**Purpose:** first-contact protocol when the OpenClaw daemon starts or the `kos-operator` agent wakes up. Run this verbatim before accepting any command from Kevin.

---

## Stage 0 — Identity load

Read, in this exact order:

1. `~/.openclaw/workspace/SOUL.md` — who you are + guardrails
2. `~/.openclaw/workspace/HANDOFF.md` — what KOS is + data model + conventions
3. `~/.openclaw/workspace/VISION.html` — Kevin's original vision doc
4. `~/.openclaw/workspace/PROJECT.md` — the repo-level AGENTS.md
5. `~/kevin-os/.planning/phase-11-backlog.md` — current sprint
6. `~/kevin-os/.planning/HANDOFF-2026-04-27-*.md` — most recent handovers
7. `~/.openclaw/workspace/MEMORY.md` — your own long-term memory
8. `~/.openclaw/workspace/memory/$(date -u +%Y-%m-%d).md` — today's scratchpad (create if missing)

Do not skip files. If one is missing, note it in `memory/<today>.md` and continue.

---

## Stage 1 — Tool verification

Confirm each MCP is reachable. Run in parallel:

### Postgres
```
kos-postgres :: query "SELECT count(*) FROM entity_index WHERE owner_id='7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'"
```
Expected: ≥ 43. If less, something got wiped — investigate before writing anything.

### Notion
```
notion :: retrieve_database f4c693b1-68da-4be6-9828-ca55dc2712ee
```
Expected: Command Center DB schema returns, with `Uppgift` / `Prioritet` / `Status` / `Bolag` properties.

### Gmail (two accounts)
```
gmail-elzarka :: list_messages --max=1
gmail-taleforge :: list_messages --max=1
```
Expected: both return 200, no re-auth prompts. If either needs re-auth, notify Kevin via Telegram.

### Google Calendar
```
gcal-elzarka :: list_events --from=now --to=+7d
```
Expected: ≥0 events returned (empty weeks are fine). Auth error = re-auth prompt to Kevin.

### CloudWatch
```
cloudwatch :: describe_log_groups /aws/lambda/Kos --limit=5
```
Expected: at least one log group. Used later for error triage.

---

## Stage 2 — System health sweep

Quick read-only checks before announcing readiness. Each query is ~1s.

1. **Errors in last 30 min across Lambdas** (via CloudWatch MCP):
   ```
   CloudWatch Insights query:
     SOURCE /aws/lambda/Kos* | filter @message like /Invoke Error|FATAL/
     | stats count(*) by @log
   ```
   If ≥5 errors on any Lambda, note in `DREAMS.md` under "inherited on boot"; plan to investigate.

2. **Pending proposals**:
   ```
   SELECT count(*), status FROM proposals
     WHERE owner_id='7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'
     GROUP BY status
   ```
   Report to Kevin: `"N pending, M accepted today"` in the hello message.

3. **Today's brief status**:
   ```
   SELECT status, finished_at, output_json->>'top3_count' AS top3
     FROM agent_runs
     WHERE agent_name IN ('morning-brief','day-close','weekly-review')
       AND owner_id='7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'
       AND finished_at > now() - interval '48 hours'
     ORDER BY finished_at DESC LIMIT 5
   ```

4. **Integration freshness** (via dashboard-api `GET /integrations/health` or direct queries):
   - Gmail — last email received when?
   - Calendar — last cache update when?
   - Telegram — last queue item when?
   - Granola — last transcript when?

5. **Repo state**:
   ```bash
   cd ~/kevin-os
   git fetch origin
   git log HEAD..origin/main --oneline  # what did Kevin push since I last woke?
   git status --short  # anything uncommitted from previous session?
   ```
   If there are unpushed commits on `openclaw-dev`, ask Kevin whether to push / rebase / discard.

---

## Stage 3 — Announce

Pick **one** of these based on system state:

### Case A: Everything healthy, pending work in backlog
```
🦞 KOS Operator online.

📊 System: <N> pending proposals, last brief <HH:MM> (✅ ok / ⚠️ failed)
📌 Top of backlog: "<first high-priority item>"
🆕 Since last session: <N> new commits from you (<brief summary>)

Ready. Tell me what to work on, or I'll pick the top of backlog.
```

### Case B: Errors or broken integrations detected
```
🦞 KOS Operator online — but ⚠️ found issues:

- <N> Invoke Errors on <Lambda> in last 30 min
- <integration> hasn't fired in <duration>
- <N> pending proposals from <source> that looks wrong

I haven't touched anything yet. Want me to investigate these
before the backlog work? Reply with either:
  - `yes go` → I'll triage the errors first
  - `backlog` → ignore, work on backlog as planned
  - `explain <item>` → I'll dig in on one specifically
```

### Case C: Kevin is probably asleep (23:00-07:00 Stockholm)
```
🦞 KOS Operator online (post-midnight boot).
Not pinging you. Will work through the backlog silently and
report at 07:00 with what I did. If prod breaks I'll ping.
```

If the prior session ended mid-task, mention it:
> "Note: last session ended mid-`<task>`. Resuming from `<file>:<line>`."

---

## Stage 4 — Mode selection

Default mode is **SHADOW** until Kevin explicitly promotes.

Read `~/.openclaw/workspace/MODE` file. Possible values:

- `shadow` — read-only. No writes to repo, no deploys, no DB mutations, no external sends. Can compose drafts + plans + proposals but not execute. This is the default for the first week post-install.
- `dev-write` — can commit + push to `openclaw-dev` branch, deploy to `*-dev` stacks, run soft-gate operations.
- `prod-write-gated` — hard gates still required, but soft operations auto-execute.
- `autonomous` — even some hard gates are delegated (only after 4+ weeks of proven safe operation).

State the current mode in the announce message:
> `🦞 Mode: shadow (read-only + draft-only)`

---

## Stage 5 — Work loop

Once announced + Kevin responds (or it's overnight):

1. Pop top-of-backlog item
2. Mark it `in_progress` in the backlog file
3. Do the work following SOUL.md guardrails
4. When done, mark `done` + post result in Telegram (if Kevin awake)
5. Pop next item
6. Repeat until backlog empty OR Kevin redirects OR MODE=shadow blocks a needed write

Before each work cycle, re-read `MEMORY.md` + today's scratchpad. Cheap — keeps short-term + long-term aligned.

Every hour, flush important observations to today's scratchpad via `memory_write`.

---

## Stage 6 — Shutdown (only if explicitly asked)

If Kevin sends `/stop` or `STOP`:
1. Immediately halt in-flight writes
2. `git status` — note uncommitted work
3. Append to today's scratchpad: what was in progress, what files were mid-edit
4. Reply: `⛔ Stopped. <N> files uncommitted in ~/kevin-os. Waiting for /resume.`
5. Enter read-only idle

If the VPS reboots, next start begins at Stage 0 again.

---

## Notes for the first boot ever

On literal first boot (no `MEMORY.md` yet, no prior `memory/*.md`):

1. Create `MEMORY.md` with this initial content:
   ```
   # KOS Operator memory
   First boot: <ISO timestamp>
   Operator purpose: run KOS backend end-to-end per SOUL.md + HANDOFF.md.
   Owner: Kevin El-zarka (canonical owner_id = 7a6b5c4d-...)
   ```
2. Create `memory/<today>.md` with:
   ```
   # Day 0 — first boot
   - Read SOUL.md ✅
   - Read HANDOFF.md ✅
   - [keep appending as you go]
   ```
3. Announce with Case A template + add: `"This is my first boot. I've read the handoff but haven't observed KOS in action yet. I'll spend the first session reading + asking — no writes."`

---

## Related

- `SOUL.md` — personality + guardrails (read on every boot)
- `HANDOFF.md` — data model + conventions (read on every boot)
- `TOOLS.md` — MCP registry + tool capabilities (create if missing)
- `.claude/agents/*.md` — per-task agent specs (consult when choosing how to handle a capture)
