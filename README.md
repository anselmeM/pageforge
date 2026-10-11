# PageForge

A local comic-book reader for **CBZ/ZIP archives** and **folders of images**.

PageForge is an independent implementation built from the observed feature set of
CDisplayEx 1.10.33 (its release notes, its translation catalog, and its installed
file inventory on this machine). It shares no code, assets, or branding with
that product, and it does not read or modify CDisplayEx's files.

## Status: milestone 1 — core reading

Working today:

- Opens **CBZ/ZIP** archives and **folders of images** (recursive, depth-limited)
- Page order is natural filename order (`page2` before `page10`)
- Packaging noise is skipped: `__MACOSX/`, AppleDouble `._*`, `.DS_Store`, `Thumbs.db`
- **Single page** and **double page** reading; a wide page gets a spread to itself
- **Right-to-left** (Japanese) reading direction, which also mirrors the click zones
- **Fit to screen / width / height** and **actual size**, plus zoom in/out with
  anchored zoom-at-cursor and pan clamped to the page
- **Rotate** left/right, **full screen**, keyboard, mouse wheel, drag-to-pan and
  page-turn click zones
- Page dimensions come from image headers (PNG, JPEG, GIF, BMP, WebP), so spreads
  are laid out without decoding every page first

Not implemented yet (deliberately deferred): CBR/CB7 and other archives, PDF,
DjVu, TIFF/AVIF decoding, thumbnail bar, bookmarks and history, resume-last-page,
configurable keyboard shortcuts, colour correction, resampling choices, page
cache, portable configuration.

## Requirements

- Node.js 22 or newer (developed on 24)
- Electron is installed as a dev dependency; no system runtime is required

## Run

```sh
npm ci
npm start                      # opens empty
npm start -- "D:\comics\book.cbz"
```

`npm start` goes through `scripts/launch.mjs`, which clears
`ELECTRON_RUN_AS_NODE` before starting Electron. If that variable is inherited
from a parent Electron host, `electron.exe` starts as plain Node and the
`electron` module has no API; the launcher removes that failure mode. Running
`node_modules/.bin/electron .` directly skips that protection — the app detects
the situation and explains it rather than crashing obscurely.

## Keyboard

| Key | Action |
| --- | --- |
| `→` `Space` `PageDown` | Next page |
| `←` `PageUp` | Previous page |
| `Home` / `End` | First / last page |
| `Ctrl`+`G` | Go to page |
| `+` / `−` | Zoom in / out |
| `0` | Actual size (100%) |
| `F` / `W` / `H` | Fit screen / width / height |
| `D` | Toggle double page |
| `J` | Toggle right-to-left reading |
| `R` / `Shift`+`R` | Rotate right / left |
| `F11` | Full screen |
| `Ctrl`+wheel | Zoom at cursor |
| Wheel | Scroll the page, then turn the page at the edge |

## Architecture

```
src/core/      pure logic, no Electron and no DOM: page ordering, image header
               parsing, spread grouping, fit and pan arithmetic
src/main/      Electron main process (CommonJS), the archive/folder reader, and
               the pageforge:// protocol that serves page bytes
src/renderer/  the viewer: DOM, input, and the chrome
scripts/       fixture generator, launcher, smoke test
```

Two decisions worth knowing:

- **The main process is CommonJS.** Electron's main-process `electron` module is a
  CommonJS built-in; an ES-module entry cannot import its members, and requiring
  it through `createRequire` resolves to the npm shim instead. The reader stays an
  ES module and is loaded with `import()`.
- **The viewer is served over `pageforge://app/…`, not `file://`.** Chromium
  blocks ES-module imports over `file://`, and the viewer imports `src/core/`
  directly. The same privileged scheme also serves page bytes from
  `pageforge://page/<n>`, so images are fetched, decoded and cached by Chromium
  like any other image.

## Tests

```sh
npm test        # 42 unit and reader tests
npm run smoke   # launches Electron against a generated CBZ and asserts it decodes
npm run verify  # both
```

The fixture is generated, not committed: `scripts/make-fixture.mjs` writes real
PNG and BMP bytes and packs them into a real ZIP, including the packaging noise a
CBZ usually carries. `/scripts/smoke.mjs` is the only check that exercises the
protocol, the preload bridge and the viewer together.

To render a PNG of the app without clicking anything:

```sh
npm run fixture
node scripts/launch.mjs --capture=out.png --capture-command=double-on fixtures/sample.cbz
```

## Observed versus chosen behaviour

Kept explicit, because a reader that silently guesses is worse than one that
says what it does not know:

| Area | Basis |
| --- | --- |
| Supported formats, reading modes, zoom/fit/rotate, RTL mode, full screen, page caching, configurable shortcuts, colour correction | **Observed** in CDisplayEx's release notes and translation catalog |
| Landscape pages occupy their own spread | **Inferred** — a common rule for two-page scans, not verified against CDisplayEx |
| First page shown alone in double-page mode | **Chosen default off**; some readers do this for covers, CDisplayEx's default is unverified |
| "Fit Landscape" / "Fit Portrait" | **Not implemented**, because their exact semantics were not observed; guessing would be worse than omitting them |
| Keyboard shortcuts and click zones | **Chosen** for this app; CDisplayEx's bindings were not inspected |
