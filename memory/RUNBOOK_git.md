# Runbook — Git (`git/git-client.ts`)

## Rules

- `git -C <dir>` with `posixQuote`. Refs/dirs validated.
- Never force-push, never `reset --hard`, never rewrite history silently.
- Stage/commit are explicit user actions; status/diff are read-only.

## Commands

- `rev-parse --is-inside-work-tree` → isRepository
- `status --porcelain=v2 -b` → GitStatus (branch/ahead/behind/clean)
- `diff` / `diff --cached` → raw diff
- `log --oneline -20` → GitLogEntry
- `add <path>` / `commit -m` → explicit only

## Deploys

`projects/projects.ts` plans → preview → `startCommandJob` (detached job runner). Same markers as recipes.

## Status

Implemented — needs real work tree for Verified.
