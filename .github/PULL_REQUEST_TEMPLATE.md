## What this changes

<!-- One or two sentences. Explain WHY, not what — the diff already says what. -->

## Type

- [ ] `feat` — a new capability
- [ ] `fix` — a defect
- [ ] `refactor` / `perf` — behaviour is unchanged
- [ ] `test` — tests only
- [ ] `docs` — documentation only
- [ ] `ci` / `chore` — tooling, dependencies, configuration
- [ ] `revert` — undoes a previous change

## Checklist

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/), one logical change each
- [ ] `npm test` passes locally
- [ ] `npm run verify` passes, or the reason it was not run is written below
- [ ] `npm run dist` and `npm run verify:dist` pass if the packaged app is affected
- [ ] Tests added or updated for changed behaviour
- [ ] README updated if behaviour, shortcuts, formats or storage changed
- [ ] No secrets, tokens, personal paths or debug leftovers
- [ ] No scope creep — unrelated changes are in their own PR

## How this was verified

<!--
Name what you actually ran and what it proved. "Tests pass" is weaker than
"npm test: 315 pass; verify:dist: guided view detects 4 panels on the fixture".
Say so explicitly if something is verified by hand rather than by CI, because CI
cannot check a real comic: the fixtures are synthetic.
-->

## Notes for the reviewer

<!-- Known limitations, deliberate trade-offs, anything you were unsure about. -->

Closes #
