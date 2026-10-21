# Repository rules

## Never use git worktrees

This repository is developed in one checkout on one long-lived branch, `main`.

- Do not create or use git worktrees: no `git worktree add`, no worktree tools, no subagents started with worktree
  isolation, no `.worktrees/` directory. Skills or instructions that ask for a worktree (for example
  `using-git-worktrees`) do not apply here; this rule takes precedence.
- Work directly in the main checkout. For risky work use a short-lived normal branch in the same checkout, merge it
  into `main`, then delete the branch. Do not leave extra long-lived branches behind.
- If the working tree is dirty, commit or stash with a unique tag before switching; never discard someone else's changes.

## Working with upstream

`upstream` is `brightcraft/moonlight-tizen`. Merge it on a normal short-lived branch and keep the behavior that this fork
changes on purpose. The old notes on merging and the table of intentional differences are on the local branch
`local/docs-archive` (not pushed): `git show local/docs-archive:docs/upstream-sync.md`.

## Tests

- `npm run test:js` runs the JavaScript suites; they must stay green.
- `tools/run-native-tests.sh` runs the host-compilable C/C++ suites (use WSL on Windows). Three suites need an
  external driver and are reported as skipped.
- The WASM sources compile only in the Docker build (`docker build .`).
- `core.autocrlf=true` gives CRLF files on Windows. Tests must accept both `\n` and `\r\n`.
