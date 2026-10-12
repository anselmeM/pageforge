# PageForge

A local comic-book reader for **CBZ/ZIP**, **CBR/RAR**, **CB7/7Z** and **PDF**,
plus plain folders of images.

PageForge is an independent implementation built from the observed feature set of
CDisplayEx 1.10.33 (its release notes, its translation catalog, and its installed
file inventory on this machine). It shares no code, assets, or branding with
that product, and it does not read or modify CDisplayEx's files.

## Status: milestone 7 — reading modes and scan repair

Working today:

- Opens **CBZ/ZIP**, **CBR/RAR**, **CB7/7Z**, **PDF**, and **folders of images**
  (recursive, depth-limited)
- Page order is natural filename order (`page2` before `page10`)
- Packaging noise is skipped: `__MACOSX/`, AppleDouble `._*`, `.DS_Store`, `Thumbs.db`
- **Single page**, **double page**, and **vertical continuous scroll**; a wide page
  gets a spread to itself. The vertical column can be built from **detected panels**
  rather than whole pages, which makes a comic legible on a wide or short window.
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
  and keeps **named bookmarks** per book. Resuming says where it resumed and offers
  the first page instead of only flashing a toast.
- **Reads ComicInfo.xml**: a book that declares itself right-to-left opens that way,
  an explicit page order is honoured, and series and issue are shown in the status bar
- **Layout is remembered per book**: reading mode, direction, fit and rotation are
  stored against the book, so a manga volume opens right-to-left whatever the last
  book was. Turn it off with "Remember layout per book".
- **Thumbnail strip** with lazy per-page previews that jumps to any page
- **Colour correction** (off, estimated per page, or manual gamma and colour boost)
- **Scan filters**: brightness, contrast, grayscale, sepia and unsharp sharpening,
  for making a poor scan readable
- **Scaling quality** (nearest, linear, high quality) and pages **decoded ahead**
  of the reader
- **Magnifier** lens that follows the pointer, an **automatic slideshow**, and
  **rebindable primary and secondary** keyboard shortcuts
- **Guided view**: panels are detected automatically and the page keys step
  through them one at a time, with an optional spotlight on the focused panel
- **Progress percentage** in the status bar, and a progress report while a large
  archive is being opened

Not implemented, each for a stated reason: CBT/TAR archives and DjVu (format work
not yet done), a true Lanczos kernel and perceptual vibrance (the settings say what
they actually do instead), "Fit Landscape"/"Fit Portrait" (semantics never
observed), and portable configuration.

## Reading a long comic

`V` (or the **Scroll** button) reads the book as one continuous column instead of
page by page: rows are laid out full width, loaded as they come into view, and the
status bar follows the page under the middle of the screen, so resume, bookmarks and
the thumbnail strip keep working. Zoom in and out with `+`/`-` widens or narrows the
column rather than scaling a page.

**The column is built from panels, not pages.** Each page is run through the same
panel detector guided view uses, and when the result is trustworthy the page
becomes one row per panel, cropped to the panel and scaled to the column. That is
what makes a comic legible in a wide or short window, where a whole page is
unreadably small. The crop is background geometry on a single decoded page image,
so no page is decoded twice and each panel costs one DOM row.

A page whose detection is *not* trustworthy is shown whole, which matters more here
than in guided view: a wrong split in a strip is a visible seam in the middle of
someone's reading, rather than one more keypress. A page is rejected when it has
fewer than two panels, more than 18 (fragmentation), panels covering under 40% of
the page, or a panel thinner than 1:6 either way. On a real 41-page comic this
correctly rejects the cover and stacks the 4 panels of an interior page.

Turn it off with "Stack panels in the column" in Reading Quality.

Detection runs a couple of pages at a time around the reader, so the column gains
panels as it is read rather than blocking on the whole book, and a rebuild preserves
the reading position as a fraction of the current page.

PDFs are drawn only for the two pages either side of the reader, and are shown whole
rather than stacked, because cropping a PDF panel would mean a canvas per panel.

Vertical scroll and guided view are mutually exclusive — they are two ways to read
the same page — so switching one on switches the other off. The strip is a different
answer to the same problem as guided view: the camera owns the viewport in guided
view, and the scrollbar owns it in the strip, and neither fights the other.

## What a book says about itself

`ComicInfo.xml` is the metadata file inside a comic archive, and it carries the
things a filename cannot. PageForge reads three of them:

- **Reading direction.** `Manga` with `YesAndRightToLeft` (the convention found in
  the wild) or an explicit `ReadingDirection` opens the book right-to-left, so a
  manga volume reads correctly without being told. A direction you chose yourself
  for that book wins over the metadata.
- **Page order.** An explicit `<Pages>` list is applied, but only when it covers
  every page exactly once. A list that would hide or duplicate a page is ignored
  rather than half-applied, because silently dropping a page is worse than ignoring
  a bad file.
- **Series and issue**, shown in the status bar (`Test Manga #3`).

The XML is a small, flat, machine-written document, so a focused subset parser is
used instead of a general XML library. What is deliberately *not* supported: DTDs
and entity definitions (so no external entity resolution and no entity expansion
blow-up — a `<!ENTITY>` is skipped, and an undefined entity is left as written
rather than guessed at), namespaces, and attribute-value normalisation. Malformed
markup is recovered from rather than thrown on, because a book with a slightly
broken metadata file should still open — and metadata that cannot be read must
never stop a book from opening.

## Resume and quitting

Reading position is sent as soon as the page changes, not debounced. A debounced
update that has not been sent yet cannot be flushed on the way out, so quitting
within the debounce window silently lost the page you were on. Page turns are human
paced, and the main process coalesces the disk write, so sending immediately costs
nothing and removes the window. `npm run smoke` covers it: a page turned and then
quit straight away must still be remembered.

Brightness, contrast, grayscale, sepia and sharpening are separate from colour
correction: colour correction neutralises a cast, scan filters make a bad scan
readable. They are all one SVG filter chain, so a page is filtered as it is painted
rather than copied through a canvas.

Brightness and contrast share one linear stage — `value * (brightness * contrast) +
0.5 * (1 - contrast)` — the gamma stage carries the white-balance gains, and sepia is
a single matrix blended between identity and the classic sepia matrix, so a partial
sepia is one node rather than two passes. Sharpening is a 3x3 unsharp kernel whose
weights sum to one, which is asserted by a test: it changes edge contrast without
changing overall luminance.

## Guided view

Press `G` (or the **Panels** button) and PageForge finds the panels on the page and
frames them one at a time; the page keys step forward and back through them before
moving to the next page.

Panels are found by recursive gutter splitting: a page of comic art is separated by
gutters — thin runs of rows or columns that are nearly uniform — so a region is cut
at the widest qualifying gutter and each half is examined again. Three rules keep it
from cutting artwork to pieces, and they exist because the naive version cut a cover
into thirteen fragments:

- **A gutter is thin.** A flat band wider than 6% of the axis is background — a
  black cover, a night sky, a solid panel — not a separator.
- **Both halves must have room to be a panel**, so a split never produces a
  fragment.
- **A region with no variation is dropped**, not reported as a panel.

The detector samples the page at up to 800px and converts its parameters from page
pixels, because a gutter that is 5px on the page is under 2px in a quarter-scale
sample and would otherwise be dismissed as noise.

Honest limits: detection is heuristic, so it is best on ordinary panel grids. A
splash page or a cover is shown whole or split oddly — that is a property of the
technique, not a bug to hide. The camera, the panel geometry and the detection
thresholds are all adjustable in Reading Quality (`Ctrl`+`,`): panel fill, travel
time, easing, and whether the spotlight dims the rest of the page.

## Magnifier, slideshow and shortcuts

The magnifier samples the page bitmap under the pointer and draws it into a round
lens. Because a pointer offset measured on screen is not a bitmap offset once the
page is rotated, the display rotation is undone before sampling, and the lens is
rotated back so the magnified content reads the same way as the page. Toggling it
on places the lens at the middle of the page until the pointer moves, so the
feature is visible rather than invisible-until-you-hover.

The slideshow advances one spread at a time on an interval and stops at the end of
the book, or as soon as a different book is opened.

Shortcuts are stored per command in a primary and a secondary slot, and can be
reassigned in the Keyboard Shortcuts dialog: click a key, press a new one, or press
`Esc` to leave the slot unbound. **A key can only mean one thing** — binding a key
that another command already owns unbinds it there, and the dialog shows the result
immediately. Commands that a menu accelerator already owns (open, bookmarks,
thumbnails, recents, full screen, go-to-page, preferences) are deliberately not
rebindable: two owners for one combination is how a key ends up firing twice.

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

Every key below is a **default**; all of them can be reassigned in the Keyboard
Shortcuts dialog (`Help → Keyboard Shortcuts…`). Commands marked with a menu
accelerator are not rebindable.

| Key | Action |
| --- | --- |
| `→` `Space` | Next page |
| `←` `PageUp` | Previous page |
| `Home` / `End` | First / last page |
| `+` / `−` | Zoom in / out |
| `0` | Actual size (100%) |
| `F` / `W` / `H` | Fit screen / width / height |
| `D` | Toggle double page |
| `J` | Toggle right-to-left reading |
| `R` / `Shift`+`R` | Rotate right / left |
| `M` | Toggle the magnifier |
| `S` | Start or stop the slideshow |
| `G` | Toggle guided view |
| `V` | Toggle vertical scroll |
| `Ctrl`+wheel | Zoom at cursor |
| Wheel | Scroll the page, then turn the page at the edge |
| `Ctrl`+`O` / `Ctrl`+`Shift`+`O` | Open comic / folder |
| `Ctrl`+`B` / `Ctrl`+`Shift`+`B` | Add a bookmark / list bookmarks |
| `Ctrl`+`T` | Show or hide the thumbnail strip |
| `Ctrl`+`R` | Recent books |
| `Ctrl`+`G` | Go to page |
| `Ctrl`+`,` | Reading quality settings |
| `F11` | Full screen |

## Build a Windows executable

```sh
npm run dist        # one self-contained file: release/PageForge-0.1.0-portable.exe
npm run dist:dir    # an unpacked folder: release/win-unpacked/PageForge.exe
```

The portable build is a single ~108 MB `.exe` that unpacks itself to a temporary
directory and runs. Nothing needs installing, and it can be copied anywhere.

Packaging details that matter:

- **Close the app before building.** Windows keeps the running executable locked,
  so the build stalls instead of failing. `npm run dist` checks for a running
  PageForge first and stops with that reason.
- **The WASM decoders are unpacked from the asar.** `7z-wasm` and `node-unrar-js`
  are listed under `asarUnpack`, because they load `.wasm` files that a packaged
  app must be able to read from disk.
- **The portable launcher does not attach the app's stdout**, so `--smoke` cannot
  report through the pipe. `--report=<file>` writes the same report to a file
  instead, and that is what the packaged verification uses.
- **The build is unsigned.** Windows SmartScreen will warn on first run; choose
  "More info → Run anyway". Signing needs a certificate this project does not have.
- `electron-builder` is a development dependency, so it never ships inside the
  app. `npm audit` reports moderate findings in its transitive tree; none of them
  reach the packaged output.

### Verify a packaged build

```sh
npm run verify:dist                                   # release/win-unpacked/PageForge.exe
node scripts/verify-dist.mjs release/PageForge-0.1.0-portable.exe
```

This launches the real executable and checks what packaging can break: every
archive format (including the unpacked WASM decoders), the PDF path (pdf.js read
back out of the asar), a full render to PNG, and that no staged extraction
directory is left behind on exit.

### Check one comic end to end

```sh
npm run verify:archive -- "D:\comics\some book.cbz"
```

Opens the file through the same reader the app uses and **reads every page**,
reporting the page count, total bytes, elapsed time, any page that comes back
empty, and any page whose bytes disagree with its probed header. Opening a book
and showing page one does not prove page seventeen reads.

### Automation flags

The app takes a few flags that make it verifiable without a human:

| Flag | Effect |
| --- | --- |
| `--smoke <path>` | Open that book, print a one-line JSON report, exit |
| `--report=<file>` | Also write that report to a file |
| `--capture=<file>` | Write a PNG of the finished window, then exit |
| `--command=<name>` | Run one viewer command after the first book opens |
| `--settle=<ms>` | Wait before capturing, so lazy content has loaded |

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
npm test        # 191 unit, store, colour, magnifier, panel, ComicInfo, shortcut and reader tests
npm run smoke   # launches Electron against every format fixture, then proves
                # resume, bookmarks, white balance, scaling, the magnifier,
                # the slideshow and key rebinding
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
| Resume, recent list, named bookmarks, thumbnail strip | **Observed** in CDisplayEx's catalog ("Resume", "Open Recent", "Bookmarks", "Show thumbnails") |
| Magnifier, slideshow, primary **and secondary** rebindable shortcuts | **Observed** in CDisplayEx's catalog ("Magnifier", "Automatic Slideshow", "Slideshow interval", "Shortcut", "Secondary shortcuts") |
| Keyboard shortcuts and click zones | **Chosen** bindings; CDisplayEx's own bindings were not inspected |
| Menu-owned commands are not rebindable | **Chosen**; two owners for one key combination causes double firing |
| CBT/TAR, DjVu | **Not implemented**; CDisplayEx supports both |
| Guided view with automatic panel detection | **Not from CDisplayEx**, which has no guided view. Independently implemented from the well-known gutter-splitting technique; no code taken from any other project. |
| Detection is heuristic and tuned for panel grids | **Chosen**; covers and splash pages are shown whole or split oddly, and that is stated rather than hidden |
| Vertical scroll, scan filters, progress, per-book layout | **Not from CDisplayEx**; brought in as *ideas* only, implemented independently. The source that suggested them carries no licence, so no code was taken from it. |
| Panel strip (panels stacked in the column) | **Chosen over** putting a guided-view camera inside a scrolling column. Two things would then be positioning the same pixels, and they would fight; the strip removes the camera instead. |
| ComicInfo.xml XML parsing | **A subset parser in `src/core/comicinfo.js`**, not a dependency. The input is small, flat and machine-written; DTDs and entity definitions are skipped, which also removes the external-entity and expansion risks a general parser would have to defend against. |
| Books keyed by absolute path rather than by content digest | **Chosen** limitation; a moved or renamed book is treated as new |
| Automatic colour correction, gamma, colour boost, scaling quality, page cache | **Observed** options in CDisplayEx's catalog ("Automatic color correction", "Gamma", "Vibrance", "Lanczos (better quality)", "Linear", "Nearest (faster)", "Cache pages") |
| Colour boost implemented as a saturation matrix | **Chosen approximation**; a linear colour matrix cannot express perceptual vibrance |
| "High quality" scaling, not a Lanczos kernel | **Chosen** and labelled accordingly rather than misnamed |
| Prefetch depth defaulting to four pages | **Chosen**; CDisplayEx makes cache size a setting too |
| CBT/TAR, DjVu | **Not implemented yet**; CDisplayEx supports both |
