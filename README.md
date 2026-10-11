# PageForge

A local comic-book reader for **CBZ/ZIP**, **CBR/RAR**, **CB7/7Z** and **PDF**,
plus plain folders of images.

PageForge is an independent implementation built from the observed feature set of
CDisplayEx 1.10.33 (its release notes, its translation catalog, and its installed
file inventory on this machine). It shares no code, assets, or branding with
that product, and it does not read or modify CDisplayEx's files.

## Status: milestone 4 — reading quality

Working today:

- Opens **CBZ/ZIP**, **CBR/RAR**, **CB7/7Z**, **PDF**, and **folders of images**
  (recursive, depth-limited)
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
- PDFs are rendered by pdf.js per page and re-rendered when zoom outgrows the
  bitmap; encrypted RAR and 7z archives are reported rather than half-read
- **Resumes** each book at the page it was left on, remembers a **recent list**,
  and keeps **named bookmarks** per book
- **Thumbnail strip** with lazy per-page previews that jumps to any page
- **Colour correction** (off, estimated per page, or manual gamma and colour boost),
  **scaling quality** (nearest, linear, high quality), and pages **decoded ahead**
  of the reader

Not implemented yet (deliberately deferred): CBT/TAR archives, DjVu and TIFF/AVIF
decoding, a true Lanczos kernel, perceptual vibrance, configurable keyboard
shortcuts, portable configuration.

## Reading quality

Colour handling is a declarative SVG filter (`feComponentTransfer` plus
`feColorMatrix`), so it applies identically to page images and to PDF canvases and
costs nothing to change. Three modes:

- **Off** — pages are shown as stored.
- **Automatic** — the page is drawn into a 64×64 canvas, its channel averages are
  measured, and a grey-world white balance is derived from them. The strength
  setting blends between no correction and the full estimate.
- **Manual** — gamma and colour boost by hand.

Reading a page's pixels back requires the canvas not to be tainted, which is why
page bytes are served from the viewer's own origin rather than from a separate
host.

Two deliberate limits, because naming something after an algorithm it does not use
would be worse than leaving it out:

- **Colour boost is a saturation matrix**, not perceptual vibrance; a linear colour
  matrix cannot express the latter.
- **"High quality" scaling is the browser's high-quality downscale** through a
  canvas, not a Lanczos kernel.

Neighbouring pages are decoded ahead of the reader (four by default, configurable,
`0` disables it) so turning a page does not wait on the disk. PDF pages are skipped
there: pdf.js caches them itself, and rendering ahead would spend CPU for nothing.

## Library and resume

Recent books, bookmarks and preferences live in one JSON file under the app's
user-data directory (`library.json`). Writes are atomic — written to a temporary
file and renamed — and serialised, so an interrupted write cannot leave a
half-written library. If the file is ever unreadable it is **preserved under a
new name and reported**, rather than silently discarded, because it is the only
copy of the user's bookmarks.

Books are keyed by absolute path, with Windows paths folded to lower case and
forward slashes. A book that is moved or renamed is therefore treated as a new
book; the store cannot tell a move from a different file without hashing every
book on open, and pretending otherwise would attach one book's bookmarks to
another.

Set `PAGEFORGE_STATE_DIR` to keep a run away from the real library. The tests and
the smoke run both use it.

## How archives are read

| Format | Strategy |
| --- | --- |
| ZIP / CBZ | Read directly. The central directory gives random access, so page sizes are probed by reading a few header bytes per entry. |
| RAR / CBR | Extracted once to a private staging directory, then read as a file tree. |
| 7z / CB7 | Same staging approach; 7z-wasm extracts into its in-memory filesystem and the tree is copied out. |
| PDF | Not read by the main process at all. The bytes are served to the viewer, which renders pages with pdf.js onto canvases. |

RAR and 7z are staged because neither offers cheap random access: a solid stream
must be decompressed in order, and their decoder libraries only expose whole-entry
extraction. Reading a few header bytes per page would mean re-decompressing most
of the archive many times over. Staging costs one pass at open, then makes every
page read an ordinary file read and gives every page a known size up front.

The staging directory is owned by the reader. `close()` removes it, and a failed
removal is reported with the path rather than swallowed, so the directory cannot
quietly outlive the session.

## Requirements

- Node.js 22 or newer (developed on 24)
- Electron and the decoders are installed as dependencies; no system runtime is
  required and nothing is installed system-wide

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
| `Ctrl`+`B` | Bookmarks for this book (add, jump, delete) |
| `Ctrl`+`T` | Show or hide the thumbnail strip |
| `Ctrl`+`,` | Reading quality settings |
| `Ctrl`+`R` | Recent books |
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
               the pageforge:// protocol that serves page bytes and app assets
src/renderer/  the viewer: DOM, input, chrome, and the pdf.js integration
scripts/       fixture generator, launcher, smoke test
```

Two decisions worth knowing:

- **The main process is CommonJS.** Electron's main-process `electron` module is a
  CommonJS built-in; an ES-module entry cannot import its members, and requiring
  it through `createRequire` resolves to the npm shim instead. The reader stays an
  ES module and is loaded with `import()`.
- **The viewer is served over `pageforge://app/…`, not `file://`.** Chromium
  blocks ES-module imports over `file://`, and the viewer imports `src/core/`
  directly. The same privileged scheme serves page bytes from
  `pageforge://page/<n>`, the open PDF from `pageforge://app/document`, and
  pdf.js from `pageforge://app/vendor/…`. Everything shares one origin on
  purpose: a custom scheme does not negotiate CORS, so a cross-origin module
  import or document fetch fails with a bare status 0.

## Tests

```sh
npm test        # 88 unit, store, colour and reader tests
npm run smoke   # launches Electron against CBZ, CB7, CBR and PDF fixtures, then
                # proves resume, bookmarks, white balance and scaling quality
npm run verify  # both
```

The fixtures are generated, not committed: `scripts/make-fixture.mjs` writes real
PNG and BMP bytes, packs them into a real ZIP and a real 7z archive, writes a
valid PDF with a proper cross-reference table, and — when WinRAR's `Rar.exe` or
`PAGEFORGE_RAR_EXE` is available — produces a real RAR as well. RAR compression
is proprietary, so when no compressor exists the CBR test **skips with a reason
instead of passing**: CBR stays explicitly unverified rather than silently green.
`scripts/smoke.mjs` is the only check that exercises the protocols, the preload
bridge and the viewer together, across all four formats.

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
| Supported formats (CBZ, CBR/RAR incl. RAR5, CB7/7z, PDF, folders, WebP, animated GIF/WebP, TIFF), reading modes, zoom/fit/rotate, RTL mode, full screen, page caching, configurable shortcuts, colour correction | **Observed** in CDisplayEx's release notes and translation catalog |
| CBR and CB7 read through a staging directory rather than lazy per-page decompression | **Chosen** for this app; CDisplayEx decompresses lazily with its own cache |
| PDF pages rendered by pdf.js onto canvases | **Chosen** implementation; CDisplayEx uses an embedded PDFium build |
| Landscape pages occupy their own spread | **Inferred** — a common rule for two-page scans, not verified against CDisplayEx |
| First page shown alone in double-page mode | **Chosen default off**; some readers do this for covers, CDisplayEx's default is unverified |
| "Fit Landscape" / "Fit Portrait" | **Not implemented**, because their exact semantics were not observed; guessing would be worse than omitting them |
| Keyboard shortcuts and click zones | **Chosen** for this app; CDisplayEx's bindings were not inspected |
| Resume, recent list, named bookmarks, thumbnail strip | **Observed** features in CDisplayEx (its translation catalog lists "Resume", "Open Recent", "Bookmarks", "Add", "Delete", "Show thumbnails") |
| Books keyed by absolute path rather than by content digest | **Chosen** limitation; a moved or renamed book is treated as new |
| Automatic colour correction, gamma, colour boost, scaling quality, page cache | **Observed** options in CDisplayEx's catalog ("Automatic color correction", "Gamma", "Vibrance", "Lanczos (better quality)", "Linear", "Nearest (faster)", "Cache pages") |
| Colour boost implemented as a saturation matrix | **Chosen approximation**; a linear colour matrix cannot express perceptual vibrance |
| "High quality" scaling, not a Lanczos kernel | **Chosen** and labelled accordingly rather than misnamed |
| Prefetch depth defaulting to four pages | **Chosen**; CDisplayEx makes cache size a setting too |
| CBT/TAR, DjVu | **Not implemented yet**; CDisplayEx supports both |
