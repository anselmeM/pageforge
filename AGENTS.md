# AGENTS.md

Standing instructions for AI agents working in this repository. Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md).

PageForge is a local-first desktop comic reader for Windows, built as an Electron
app with a portable executable as the deliverable.

## Golden rules

1. **Never push to `master` directly.** Branch, commit, open a PR, merge with
   `--squash --delete-branch`. `master` **is protected on GitHub**: a PR is required,
   three checks must pass, the branch must be up to date, force-pushing and deleting
   are refused, and the rule applies to admins. So a direct push fails server-side
   even if the local hook is skipped. A pre-push hook refuses it earlier, before a
   network round trip — enable it with `npm run setup:hooks`. The hook is a
   convenience, not the enforcement; it exists only in clones that have run that.
   Protection exists because the repository is **public**; a private free-plan
   repository cannot have it, and GitHub returns 403 for both protection and rulesets.
   The hook also **runs the test suite** and refuses a push that fails it, which is
   the half that does not depend on the server. `PAGEFORGE_SKIP_TESTS=1` skips the
   tests only — never the refusal of a direct push to the default branch.
6. **This repository is public.** Everything committed is published, including the
   history and every commit body. Do not commit a licensed work — that is why eight
   screenshots of a real comic were removed. Screenshots must be taken from generated
   fixtures. Do not commit personal paths, tokens, or anything read from someone
   else's machine.
2. **Conventional Commits**, one logical change per commit, imperative subject,
   body explaining *why*. Types: `feat` `fix` `refactor` `perf` `test` `docs` `ci`
   `chore` `security` `revert`.
3. **CI is the gate; never merge red.** Run `npm test` before pushing.
4. **Never rewrite pushed history.** Squash and rebase are for your own unpushed
   branch only. Rolling something back means `git revert` on a branch, then a PR.
5. **Do not copy from an unlicensed source.** Comet 2.0 was read for ideas only and
   has no licence file; no code was taken from it. PageForge is MIT.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests. No Electron, no window — fast, and never flaky. |
| `npm run smoke` | Launches the real app against generated fixtures, every format. |
| `npm run verify` | `test` + `verify:workflows` + `smoke` + `verify:crash`. |
| `npm run dist` | Builds the portable executable. **The app must be closed first** — the exe is locked while it runs, and `scripts/ensure-not-running.mjs` fails fast with that reason. |
| `npm run verify:dist` | Verifies the *packaged* build: formats, full screen round trip, guided view, vertical scroll, panel strip, ComicInfo, index cache, thumbnails, achievements, library storage, startup failure, capture, cleanup. |
| `npm run verify:workflows` | Parses the PowerShell inside the workflow files, substituting the `${{ }}` expressions first. A syntax error there otherwise costs a whole CI cycle. |

## Architecture

Dependencies point inward, and `src/core/` must stay free of Electron and the DOM —
that is what makes the logic testable.

```
src/core/      pure logic: page ordering, spreads, fit and pan arithmetic, panel
               detection, ComicInfo, achievements, status text, thumbnail geometry
src/main/      Electron main process (CommonJS), archive readers, pageforge:// protocol
src/renderer/  the viewer: DOM, input, chrome, pdf.js integration
scripts/       fixture generator, launcher, smoke and verification scripts
```

- The main process is **CommonJS**: Electron's main-process `electron` module is a
  CommonJS built-in and an ES-module entry cannot import its members.
- The renderer runs **sandboxed** with `contextIsolation` on. Its preload may
  require only `electron`. There is no way to open an external program, deliberately.
- Where behaviour depends on a heuristic, put the rule in `src/core/` and test it
  there. `renderer.js` has no tests, so logic left in it is logic nobody checks.

## Evidence discipline

- The README has an **"Observed versus chosen behaviour"** table. Keep it honest.
- Distinguish what was **measured** from what was **assumed**. "Detection returns 4
  panels on the fixture" is evidence; "guided view works" is not.
- Panel detection is **heuristic**. CI fixtures are synthetic, so anything about
  real comics is verified by hand. Say so rather than implying CI covers it.
- Never report a check as passing without having run it. A credential-free probe
  that fails is a fact to report, not something to work around silently.

## Traps this project has already hit

- Enabling `sandbox: true` looked like it broke every format. It had not: a careless
  edit duplicated an `ipcMain.handle` registration, and Electron throws on the second
  handler, so the main process died before the window was ready. `test/ipc.test.js`
  guards that class now.
- A startup failure used to hang silently. It now reports its cause and exits; see
  "When something goes wrong at startup" in the README.
- Guided view framed empty slivers and skipped panels on pages whose image had not
  decoded. Both fixed; the reasoning is in the README.
- `npm run dist` fails with `EBUSY` if the app is running.
- A SQLite store holds its file open; tests and scripts must close it or the temp
  directory cannot be removed.

## Release

Tagging publishes. Pushing `v*` runs the **Release** workflow: tests, smoke, build,
`verify:dist`, then a GitHub Release with the executable attached. Nothing is
published unless every check passes, and the job refuses to run when the tag and
`package.json` version disagree — so bump the version before tagging.
