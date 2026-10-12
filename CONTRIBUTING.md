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

The hook does two things. Enable it once per clone:

```sh
npm run setup:hooks      # git config core.hooksPath .githooks
```

1. **It refuses a direct push to `master`**, so every change goes through a PR.
2. **It runs the test suite and refuses a push that fails it.** Six seconds, against
   about six minutes for the same run in CI.

The second job is the one that does not depend on the server. Branch protection is a
paid feature for a private repository, so if this repository is ever made private
again, the hook is what stands between `master` and a broken tree.

It is a **convenience, not the enforcement.** It lives in the working copy, so a
fresh clone has no hook until it runs that command, and `git push --no-verify` steps
around it. Skipping it for the default branch fails anyway:

```
remote: error: GH006: Protected branch update failed for refs/heads/master.
remote: - Changes must be made through a pull request.
remote: - 3 of 3 required status checks are expected.
```

To push a deliberate work in progress without the gate:

```sh
PAGEFORGE_SKIP_TESTS=1 git push
```

That skips the tests only. It does **not** allow a push to `master`, because the
point of the second job is the first job's job.

Two ways of writing this hook made it fail *open* — allowing the push it exists to
refuse, while looking like it worked. Both are guarded by tests now:

- reading stdin through `cat`, which a minimal shell may not have. The ref list came
  back empty, nothing matched, and the push went through. The check now uses shell
  built-ins only.
- `IFS= read -r a b c d`, which disables field splitting, so the whole line landed in
  the first variable and the branch name was never seen.

A hook that fails open is worse than no hook, because it is trusted.

The gate tests the **working tree**, not the commits being pushed. That is what you
want while working, and worth knowing if the two ever differ.

## Branch protection

`master` is protected, and the rule applies to admins, so it cannot be bypassed by
being the owner:

| Setting | Value |
|---|---|
| Pull request required | yes — 0 approvals, so the author may merge their own |
| Required checks | `Unit tests`, `Smoke test (Electron)`, `Package and verify the build` |
| Branch must be up to date | yes |
| Force pushes | refused |
| Deletions | refused |

This became possible when the repository was made public: GitHub refuses branch
protection and rulesets for a private repository on a free plan, returning `403
Upgrade to GitHub Pro or make this repository public`. If the repository is ever made
private again, **protection goes with it** and the hook is all that remains.

```sh
gh api repos/anselmeM/pageforge/branches/master/protection              # read
gh api -X DELETE repos/anselmeM/pageforge/branches/master/protection    # remove
```

If a required check is ever renamed, protection has to be updated to match — or no
pull request can satisfy it and nothing can be merged.

## Secret scanning

Secret scanning and push protection are enabled, along with vulnerability alerts.
Push protection refuses a push containing a detectable credential, which matters more
in a public repository than a review does.

`secret_scanning_non_provider_patterns` and `secret_scanning_validity_checks` are
requested but report as disabled, so generic non-provider patterns and live
credential verification are **not** covered. Do not assume they are.


## Checks

| Command | Runs |
|---|---|
| `npm test` | Unit tests. Pure logic, no Electron, no browser. |
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
