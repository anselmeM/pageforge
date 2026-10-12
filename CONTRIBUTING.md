# Contributing to PageForge

## The workflow

Every change lands through a pull request. `master` is the default branch.

```sh
git switch master && git pull
git switch -c <type>/<brief-description>     # feat/ fix/ docs/ chore/ refactor/
# ...one logical change, conventional commits...
npm test                                      # the fast gate
git push -u origin <type>/<brief-description>
gh pr create --fill
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Squash keeps `master` linear, one commit per change.

### Branch names

`<type>/<brief-description>`, lowercase with hyphens: `fix/guided-view-slivers`,
`chore/branch-pr-workflow`.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat` `fix`
`refactor` `perf` `test` `docs` `ci` `chore` `security` `revert`. One logical
change per commit; the body explains *why*, since the diff already shows what.

### Pull requests

Keep them small — roughly under 400 lines. The template asks what you ran and what
it proved, because "tests pass" is weaker than naming the checks and their results.
If something was verified by hand rather than by CI, say so.

## The pre-push hook

A hook blocks direct pushes to `master`. Enable it once per clone:

```sh
npm run setup:hooks      # git config core.hooksPath .githooks
```

It is a **guardrail, not a gate.** It lives in the working copy, so a fresh clone
has no hook until it runs that command, and `git push --no-verify` steps around it.
If a change genuinely must go straight to `master` — a broken release, a fix to the
release workflow itself — use `--no-verify` and say why in the commit body.

## Why `master` is not protected on GitHub

Real enforcement is server-side branch protection, and it cannot be enabled here.
This repository is private on a free GitHub plan, and GitHub refuses both branch
protection and rulesets:

```
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.",
 "status":403}
```

That is a plan limitation, not a permissions problem. Making the repository public,
or upgrading to GitHub Pro, would allow requiring a PR and passing checks on
`master`. Until then the hook plus discipline is what there is. **CI does already
run on pull requests**, so a red PR is visible before merge — that part is real.

## Checks

| Command | Runs |
|---|---|
| `npm test` | 315 unit tests. Pure logic, no Electron, no browser. |
| `npm run smoke` | The real app against generated fixtures, every format. |
| `npm run verify` | Tests, workflow parsing, smoke, crash reporting. |
| `npm run verify:dist` | The *packaged* executable, after `npm run dist`. |
| `npm run verify:workflows` | Parses workflow PowerShell so a typo is not found by CI. |

`npm run dist` needs the app **closed** — Windows locks the executable while it
runs. `scripts/ensure-not-running.mjs` fails fast and says so.

Note that `npm run smoke` leaves a SQLite file behind unless the store is closed;
the scripts do this, and new ones must too.

## Where logic belongs

Put anything that can be reasoned about without a window in `src/core/`, and test
it. `src/renderer/renderer.js` is large and has no tests, so logic left there is
logic nobody checks — several bugs in this project were exactly that, including a
status bar that twice named a page the viewport was not showing.

## Tests

Prefer a test that would fail if the behaviour regressed over one that restates the
implementation. When a rule is tuned against real evidence — for example the panel
geometry limits — keep the measured values in the test so the reasoning is
reproducible. Where the fixtures cannot reach the real world, write down what is
verified by hand instead.

## Releasing

Bump `package.json` (`npm version 0.1.2 --no-git-tag-version`), then tag and push:

```sh
git tag -a v0.1.2 -m "PageForge 0.1.2"
git push origin v0.1.2
```

The Release workflow tests, smokes, builds, verifies the packaged build, and only
then publishes a GitHub Release with the executable attached. It refuses to run if
the tag and `package.json` disagree.
