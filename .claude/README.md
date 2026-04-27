# .claude/ — OpenClaw workspace for the KOS Operator

This directory is read by the OpenClaw daemon on boot. Anything here is part of the agent's operating context.

## Files

- `agents/BOOT.md` — first-contact protocol on every wake
- `agents/SOUL.md` — personality + 🔴🟡🟢 guardrails
- `agents/HANDOFF.md` — symlink to `.planning/HANDOFF-OPENCLAW.md` (data model, Notion conventions, agent manifest)

## How OpenClaw picks this up

On the VPS:
```bash
git clone <repo-url> ~/kevin-os
cd ~/kevin-os
openclaw onboard --agents-dir .claude/agents
```

OpenClaw auto-loads `BOOT.md` + `SOUL.md` + `HANDOFF.md` on every daemon start. Updating these files + `git pull` on the VPS is how you update the agent.

## Mode file

A plaintext file named `MODE` in `~/.openclaw/workspace/` controls blast radius:

- `shadow` — read-only (default for first week)
- `dev-write` — can commit to `openclaw-dev` branch + deploy to `-dev` stacks
- `prod-write-gated` — soft-gate operations auto-execute, hard gates still require confirm
- `autonomous` — last step, some hard gates delegated

NEVER set `autonomous` before 4+ weeks of verified safe operation.
