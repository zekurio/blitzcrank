---
name: land
description: >-
  Land reviewed blitzcrank changes through a pull request and squash merge.
  Invoke only when the user explicitly requests landing or merging the changes,
  including an explicit /land invocation. Review, passing checks, preparation,
  and skill installation alone are not landing requests.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Land blitzcrank changes

Carry an explicit landing request through preparation, review, verification,
publication, and a confirmed squash merge. The invocation supplies merge intent;
do not ask for the same permission again. Stop for genuine blockers or ambiguous
scope, not routine confirmation.

This workflow applies to the repository identified by `package.json` as
`blitzcrank`. Its destination branch is `main`. Use the configured publication
remote rather than a hard-coded repository URL. Never use a local-checkout
backlink as a publication remote. See `AGENTS.md`, "Repository Guidelines,"
"Branch Names," and "Commits and PR Titles."

## Establish scope and destination

1. Read applicable `AGENT.md` and `AGENTS.md` files, contribution guidance,
   submission templates, and current CI definitions. Preserve conditional
   contribution obligations. Do not infer an approval requirement from old
   history, or waive an explicit policy because the forge does not enforce it.
2. Inspect the current branch, staged and unstaged diffs, untracked files,
   existing commits, remotes, and worktrees. Identify the exact requested change.
   Include skill changes only when they are part of the request. Leave unrelated
   work untouched; ask when its ownership or intended scope is unclear.
3. Identify the publication remote from its URL and branch tracking. Use
   `git remote -v`, with credentials redacted if present, and inspect the
   destination through its native CLI or API. If the destination is ambiguous,
   ask rather than choosing a remote by name alone.
4. Verify authentication, push permission, the destination default branch,
   supported merge methods, branch protection, effective rules, and applicable
   review requirements. The default branch must still agree with the intended
   `main` destination; otherwise clarify the target.
5. The current forge is GitHub and `gh` is supported. Derive `HOST/OWNER/REPO`
   from the selected remote for explicit `--repo` arguments. Inspect repository
   settings, branch protection, and effective branch rules using read-only API
   calls. A confirmed "Branch not protected" response is not the same as an
   authentication failure. If the forge changes, verify its supported PR/MR,
   checks, approvals, and squash-merge operations before using equivalent
   tooling. Do not run GitHub commands against another forge or silently switch
   to direct pushes. Stop if the required operations cannot be verified.

## Prepare the branch

- Fetch the selected publication remote and record the current destination
  `main` commit. Do not rewrite or force-push shared history.
- Reuse a suitable change branch and its PR when they already represent this
  request. Otherwise create a branch with at most three hyphen-separated words,
  without slashes or type prefixes. Use the current change state as the source;
  do not discard uncommitted work to start from a clean base.
- Stage only the requested files or hunks, including intended new files. Inspect
  the staged diff for secrets, generated output, and unrelated changes before
  committing. Never use an indiscriminate staging or cleanup command when other
  work is present.
- Use `type(scope): summary` commit messages and PR titles. The permitted types
  are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`; scope is optional.
  These conventions come from `AGENTS.md`, "Branch Names" and "Commits and PR
  Titles."
- Preserve the configured signing behavior. Do not disable signing, bypass
  hooks, substitute an identity, or invent a sign-off. SSH signing may require
  the configured signing agent to be unlocked; a failure is a blocker to report.
- Run commits and merges non-interactively: provide explicit messages and prefix
  commands that might open an editor with `GIT_EDITOR=true`. For example,
  `GIT_EDITOR=true git commit -m "type(scope): summary"` and
  `GIT_EDITOR=true git merge --no-edit <remote>/main`.
- If remote `main` has advanced beyond the branch's base, merge it into the
  change branch instead of rebasing or force-pushing. Resolve conflicts
  automatically only when the intended result is clear and unrelated work is
  preserved. If intent is uncertain, stop, describe the conflicting choices,
  and ask the user. Do not present a conflicted merge as completed.

## Review the exact change

Review the complete final diff against the current destination base, including
new files, dependency changes, tests, documentation, and conflict resolutions.
Existing review can be reused only for the same content. A changed diff needs
review of the changes since that review; passing tests alone are not a review.
Resolve blocking findings before proceeding.

Follow the safety invariants in `AGENTS.md`. In particular, inspect changes to
service reads and typed mutations, evidence gates, tool allowlists, session
resumption, live final-message capture, active-write shutdown, and directives.
Do not weaken an invariant without explicit operator sign-off. Describe any
behavioral change to safety/context code, resumption, directives, or allowlists
in the PR and final result. See `AGENTS.md`, "Safety Invariants," and
`README.md`, "Contributing."

Check related documentation and tests. New or renamed tools require the prompt
and relevant domain skill updates described by `AGENTS.md`, "Repo Patterns."
Configuration changes require `.env.example` updates. SDK changes require exact
pins and verification against `docs/research/pi-sdk.md`; dependency changes must
also leave the Nix dependency hash valid. Do not add unrelated version bumps,
changelog requirements, or contribution attestations.

## Verify before landing

Use Node 24 or newer as required by `package.json#engines`, and pnpm 11.
The current CI pins pnpm `11.25.0` and Node `24`. Media tests need `ffmpeg` and
`ffprobe`; the default development shell supplies them alongside Node and pnpm.
Sources: `package.json`, `.github/workflows/checks.yml`, `flake.nix` under
`devShells`, and `src/tools/media.test.ts` / `src/tools/media-frames.test.ts`.
Use that shell or an equivalent verified environment. Do not install system
packages or change machine configuration without permission.

Run the following local checks on the final candidate:

| Command                              | Repository definition                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`     | `.github/workflows/checks.yml`, both dependency installation steps; `pnpm-lock.yaml`        |
| `pnpm verify`                        | `package.json#scripts.verify`; `.github/workflows/checks.yml`, Verify step                  |
| `pnpm test`                          | `package.json#scripts.test`; `.github/workflows/checks.yml`, Test step                      |
| `pnpm build`                         | `package.json#scripts.build`; `tsconfig.json`; `.github/workflows/checks.yml`, Build step   |
| `pnpm audit`                         | `.github/workflows/checks.yml`, Audit dependencies step                                     |
| `nix flake check --print-build-logs` | `.github/workflows/checks.yml`, Check Nix flake step; `flake.nix#checks`; `nix/package.nix` |

For Nix changes, also evaluate `nix flake show`, as required by `AGENTS.md`;
the exports are defined in `flake.nix`. Ensure intended new source files are
tracked before flake validation, since Git-backed flakes omit untracked files.

Keep local verification proportional for documentation-only changes: run
`pnpm verify`, and still require all remote CI jobs below. Never use this
exception for source code, dependencies, tooling, configuration, Nix, or mixed
changes. A local flake check that skips Linux builds is not evidence that the
Linux package builds. If a local platform cannot perform that build, state the
limitation and require the successful remote Linux Nix job for the same
candidate. Do not describe skipped builds as passed.

Failures must be fixed and relevant checks rerun. Missing tools, unavailable
audit data, pending jobs, and unverifiable results are not success. Do not weaken
tests, audit thresholds, CI, or protection rules to make landing possible.

## Publish and complete the PR

1. Push the change branch normally to the selected publication remote. Never
   force-push or push directly to `main` as a substitute for this workflow.
2. Find and reuse an open PR for the exact source branch and `main` destination,
   or create one with an explicit conventional title and body. On GitHub use
   `gh pr list`, `gh pr view`, and `gh pr create` with explicit `--repo`,
   `--base main`, and `--head` where applicable. Provide `--title` and
   `--body-file` for creation rather than invoking an interactive editor.
3. The body must explain the change, tests, limitations, and any safety-sensitive
   behavioral differences. Follow any applicable submission template or
   contribution policy discovered during preflight. Do not claim tests or
   approvals that were not obtained.
4. Record the PR head SHA and verify every configured CI job for that exact
   revision. The current required workflow gate consists of `pnpm checks`,
   `Dependency audit`, and `Nix package`, defined in
   `.github/workflows/checks.yml`. Require all three to finish successfully even
   when branch protection does not mark them required. Also satisfy any
   additional destination-required checks, approvals, resolved discussions,
   or merge-queue rules discovered at execution time.
5. Inspect actual check details through `gh pr checks` and
   `gh pr view --json headRefOid,statusCheckRollup,reviewDecision,mergeStateStatus`.
   Do not rely solely on `--required` when the repository has no enforced
   required checks. A missing, skipped, cancelled, failed, or pending required
   job blocks landing. Checks on an older head SHA do not count.
6. Recheck destination rules, the PR head, and the current remote `main` before
   merging. If either code revision has changed, incorporate the new base when
   needed, review the resulting changes, and obtain successful checks again.
   Never bypass a required review or queue using administrator privileges.
7. Squash-merge only the reviewed and verified head. For the current GitHub
   setup, use
   `gh pr merge <number> --repo <repository> --squash --match-head-commit <verified-sha>`
   with an explicit conventional `--subject` and an explicit `--body-file`.
   Do not use `--admin`. If squash merging is unavailable, stop and ask rather
   than silently choosing another history policy. If a merge queue is required,
   follow it and wait for confirmed merging; entering the queue is not landing.

## Confirm the destination

- Verify the PR is actually merged and obtain its merge commit, rather than
  assuming a successful command means the merge has finished. On GitHub,
  inspect `gh pr view --json state,mergedAt,mergeCommit,url`.
- Fetch the publication remote and verify the merge commit is reachable from
  its `main` branch. Confirm the merged change matches the reviewed result.
  If verification fails, report that landing is unconfirmed and investigate;
  do not claim success from branch publication or green checks alone.
- Update local `main` only with a safe fast-forward and only when doing so
  cannot overwrite work. Use `GIT_EDITOR=true git merge --ff-only <remote>/main`
  from a clean, authorized checkout of local `main`. If another checkout owns
  that branch, or local `main` has diverged, leave it alone and explain what remains.
  Do not edit an unattached checkout, reset a branch, stash unrelated work,
  delete branches, or clean files as an automatic shortcut.
- Report the PR URL, merge commit, destination, review and verification
  results, safety-sensitive changes, and any local checkout update left
  pending. If a genuine blocker prevents merging, explicitly state that the
  changes have not landed and identify the blocker.
