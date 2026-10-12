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
- **Thumbnail strip** with lazy per-page previews that jumps to any page. Only the
  thumbnails near the visible window are mounted, so a 240-page book is 21 elements
  rather than 240.
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
- **Saved page index**: the second and later opens of an archive skip re-reading
  every page, which on a 67 MB, 41-page comic is the difference between 1142 ms and
  54 ms. Clear it from Reading Quality.
- **Opt-in crash reporting** (off by default): a crash on your machine is one you
  can debug; a crash on someone else's is invisible. Nothing is ever sent until
  reporting is switched on and a destination is set.
- **Achievements**, derived from your own reading on this machine: pages turned,
  books finished, days in a row, reading in the small hours. Unlocks are announced
  as they happen, and the list shows real progress towards the ones not yet earned.
- **Export and import the library** (positions, bookmarks, per-book layout and
  achievements) as a JSON file — the way to move to another machine or keep a
  backup, since there is deliberately no cloud.
- **Recent books grouped by series**, using the series and issue number a book's
  ComicInfo declared. Books that declare nothing stay in a plain list underneath.

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

## The saved page index

Reading a page's dimensions out of a CBZ means decompressing that page, because the
size lives in its own image header. For a large archive that is the whole cost of
opening it, and it produces the same answer every time the file has not changed, so
the result is kept.

The store is SQLite, through Node's built-in `node:sqlite` — no native module, no
rebuild step, nothing to unpack from the asar. It holds one row per page plus the
book's ComicInfo, keyed by path with the file's size and modification time as the
invalidation rule: an archive that changed in any way has a different one of them in
practice, and a changed file simply misses and is re-indexed.

Three deliberate properties:

- **It cannot break opening a book.** `node:sqlite` is marked experimental upstream,
  so it is used behind a thin wrapper; if the module is unavailable or the database
  cannot be opened, the cache reports itself as disabled and the reader probes
  exactly as it did before. A cache that can fail an open would be worse than none.
- **A cache that throws behaves like a cache that missed.** Every method answers even
  when the database is broken, and that path is tested.
- **What it stores is not the archive.** Page entries are re-looked-up from the live
  zip index, so a stale cache cannot serve bytes from a file that is gone.

Measured on a real 67 MB comic with 41 pages: 1142 ms to open with a miss, 54 ms on
the next open. `verify:dist` asserts the miss-then-hit sequence and that the cached
open reports the same page count and dimensions.

## Crash reporting

The error log PageForge writes only exists where the app was run, so a crash on
someone else's machine is invisible. Reporting fixes that, and is **off by default**.

Three rules:

- **Nothing is sent until you switch it on *and* give it a destination.** With
  reporting off, the code path refuses and no request is made — that is asserted,
  not assumed.
- **Your account name is not sent.** Stack traces carry absolute paths, and a path
  contains a person's name, so `C:\Users\<name>` is replaced with `%USERPROFILE%`
  before anything leaves the machine. The end-to-end check greps the bytes that
  arrived for the account name.
- **It can never affect reading.** A report that cannot be delivered is dropped,
  never retried, and never surfaced mid-book.

Reading Quality has a **Send a test** button. That is deliberate: only you can
confirm *your* destination works, so the app tells you whether the endpoint accepted
the report instead of leaving you to assume it did.

The wire format is Sentry's documented ingest contract — a JSON event posted to
`…/api/<project>/store/` with an `X-Sentry-Auth` header. Speaking the documented
protocol rather than bundling the SDK is a trade: it keeps an opt-in feature from
becoming a permanent dependency, at the cost of the SDK extras (breadcrumbs,
sessions, source maps).

**How far this is verified, stated plainly:** `npm run verify:crash` launches the
real app against a local server and asserts the URL, the auth header, the event
body, and the absence of the account name — but a local server implementing the
documented contract is *not* Sentry's own service. Verifying against Sentry needs a
DSN and an account, which is exactly what the test button exists for.

## Moving a library between machines

Recent Books has **Export…** and **Import…**. The file holds reading positions,
bookmarks, per-book layout and achievements — everything that makes a library yours.
There is no cloud by design, so this is how it travels.

Merging is deliberately conservative, because an import should never lose work:

- **The position from whichever copy was read most recently wins**, so importing an
  older file cannot move a bookmark backwards.
- **Bookmarks are unioned**, and one already present at the same page and name is
  not duplicated.
- **Per-book layout in use here wins**; the file only fills books that have none.
- **Achievement counters take the larger value**, and an achievement keeps the
  earliest date it was earned — importing can never reduce what you have earned.
- **Reading preferences are carried for reference but not applied.** Silently
  changing how someone's reader behaves is not what "import my books" means.
- A file that is not a PageForge library is **refused rather than half-applied**,
  and a hand-edited file cannot inject anything: every value is normalised on the
  way in, and the tests include a deliberately hostile one.

## The thumbnail strip

A page per element is fine for a thirty-page book and wrong for a thousand-page one:
every thumbnail would be a node with an image, laid out and painted even though
almost none of them can be seen. The strip keeps a rail of the full scroll width —
so the scrollbar still means the whole book — and mounts only the thumbnails near
the visible window, recycling them as it scrolls. A 240-page book mounts 21
elements. Mounted means close to visible, so a mounted thumbnail fetches its preview
straight away instead of waiting for an observer.

## Achievements

Ten of them, earned from what you read on this machine: pages turned, books
finished, ten books finished, a 100-page book finished, ten different books opened,
three and seven days in a row, and reading between midnight and 4am. Unlocks are
announced when they happen, and the list shows real progress towards the ones not
yet earned (`5 of 100`), because a bare locked state is not a goal.

Details that matter more than they look:

- **Nothing is sent anywhere.** They are computed from the local library. The dialog
  says so, because a reader is entitled to know.
- **A book counts as finished once**, however many times you reach the last page, so
  the count cannot be inflated by re-reading.
- **Day boundaries are local, and day arithmetic goes through UTC**, so a
  daylight-saving change cannot make a streak skip or double a day. A run that ended
  yesterday is still current — it should not break at midnight before you have had a
  chance to read.
- **The clock is passed in, not read.** A module that reads the clock can only be
  tested by waiting, and streaks are exactly what needs testing. A test also proves
  every achievement is reachable, so a threshold no amount of reading can meet would
  fail the suite.
- Reading history and achievements are independent: clearing history does not wipe
  them, and the dialog has its own Reset.

## Continuous integration

`.github/workflows/ci.yml` runs three Windows jobs on every push and pull request:
the unit tests, the Electron smoke suite plus the crash-report check, and a packaged
build that is then verified with `verify:dist` and uploaded as an artifact. The
packaged job is the real gate — it runs the executable people would download, not
the sources.

CBR fixtures need WinRAR to write the format, so both the smoke suite and
`verify:dist` **skip** that case with a printed reason when no compressor is
installed, rather than passing silently.

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

## Where the library lives

The library is a SQLite database (`pageforge.sqlite`) in the same directory as the
settings, through Node's built-in `node:sqlite` — no native module, no rebuild step.

It is there for two reasons, one of which was a real bug:

- **A page turn is one small update**, not a rewrite of the whole library. The old
  store held everything in memory and rewrote `library.json` on every change.
- **Two running copies can no longer overwrite each other.** There is no
  single-instance guard, so with one JSON file the second window to save silently
  discarded the other's progress. A database gives a real lock, and a test opens two
  stores on one library and proves neither write is lost.

Existing libraries migrate themselves **once**, and the migration is built so the
worst case is that it did not happen rather than that your library is gone:

1. The new database is created **beside** the old file, as
   `pageforge.sqlite.migrating-<pid>`.
2. Everything is inserted in **one transaction**.
3. It is **read back and compared** with the source — book, bookmark and achievement
   counts, and every book's reading position.
4. Only if that matches is it renamed into place.
5. Only then is the old file set aside as `library.json.migrated-<timestamp>`.

Any failure deletes the half-built file, leaves `library.json` untouched, and keeps
running on it. `node:sqlite` is marked experimental upstream, which is why the JSON
store is still there as a fallback and `PAGEFORGE_STORAGE=json` forces it. The JSON
**reader** is kept permanently, because migration and import both need it.

**To roll back**, close the app, delete `pageforge.sqlite` and rename the
`library.json.migrated-<timestamp>` file back to `library.json`.

The saved page index stays in its own file (`index.sqlite`) on purpose: it is
disposable, and being able to clear it without touching your library is a feature.

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

- **To run a build:** Windows x64. Nothing else — the portable executable is self-contained.
- **To build or develop:** Node.js 24 or newer, pinned by `.nvmrc` and declared in
  `engines`. CI reads `.nvmrc` rather than repeating the version, so the two cannot
  drift. The floor exists because the library and the saved page index both use
  Node's built-in `node:sqlite`.
- **Optional:** WinRAR installed, only so the test suite can *write* CBR fixtures.
  Reading CBR needs nothing extra. Without it, CBR test cases skip with a printed
  reason rather than passing silently.

## When something goes wrong at startup

A failure before the viewer is ready used to be the worst kind: the process stayed
alive doing nothing, `--smoke` reported a bare `{"smoke":"timeout"}` after thirty
seconds, and the actual error existed only in raw stderr. A window that never
appears and a process that says nothing are indistinguishable from a hang.

Now a failure to start **reports the cause and exits non-zero**, and for a person
launching it normally it shows a dialog rather than nothing at all:

```json
{"smoke":"error","failure":{"kind":"unhandledRejection","message":"…","detail":"…reader.js:12:3"}}
```

The watchdog still exists, but when it does fire it now carries the last recorded
failure with it, so even a timeout names something.

`PAGEFORGE_FAULT=startup` throws on purpose from inside `app.whenReady()`. That
exists so this path can be tested at all — the alternative is breaking the app by
hand, which is exactly how the silent hang went unnoticed. `npm run smoke` asserts
the cause comes back in well under a second; `verify:dist` asserts the same on the
packaged build, where the timing is dominated by the portable launcher extracting
the application and is therefore not asserted.

## Licence

[MIT](LICENSE). The dependency list is short and every entry is permissively
licensed: `yauzl` (ZIP), `node-unrar-js` (RAR), `7z-wasm` (7z) and `pdfjs-dist`
(PDF).

## Security posture

- **The viewer runs sandboxed**, with `contextIsolation` on and `nodeIntegration`
  off. Its preload requires only `electron`, which is all a sandboxed preload can
  have — there is a test that asserts exactly that, so a future change cannot
  quietly introduce a Node dependency there.
- **The renderer has a strict CSP** (`default-src 'none'` with explicit allowances),
  and page bytes are served from the same origin as the app so canvas readback for
  white balance cannot be tainted.
- **There is no way to launch an external program.** An `openExternal` channel
  existed, unvalidated and with nothing calling it; it has been removed rather than
  guarded, because an unvalidated opener is an arbitrary-protocol launcher and
  nothing in the interface needs one. A test fails if it comes back.
- **The protocol handler refuses path traversal**, resolving each request and
  rejecting anything outside the app root.
- **Nothing leaves the machine** except opt-in crash reports, which cannot be sent
  without a destination.

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
npm test        # 278 unit, store, database, IPC, colour, magnifier, panel, ComicInfo, cache, crash-report, achievement, library and reader tests
npm run smoke   # launches Electron against every format fixture, then proves
                # resume, bookmarks, white balance, scaling, the magnifier,
                # the slideshow and key rebinding
npm run verify  # all of the above, including opt-in crash reporting
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
| Archive index storage | **`node:sqlite`**, the runtime's built-in SQLite, rather than a native module. Electron 44 bundles Node 24, so there is no rebuild step and nothing to unpack from the asar. It is marked experimental upstream, so it sits behind a wrapper that disables the cache rather than failing an open. |
| Library storage | **SQLite, with the JSON store kept as a fallback.** Two windows silently overwriting each other was a real bug, and one small update beats rewriting the file on every page turn. The JSON reader is kept forever for migration and import. Existing libraries migrate once, after being verified against the source. |
| Crash reporting transport | **Sentry's documented ingest contract over `fetch`**, not the Sentry SDK. Reporting is opt-in and may never be used, so it does not justify a permanent dependency; the cost is no breadcrumbs, sessions or source maps. |
| Crash reporting default | **Off**, and it cannot send without a destination. An app that phones home by default would make the "local, offline" promise false. |
| Renderer sandbox | **On**, and verified on the packaged build rather than assumed. The preload needs only `electron`, so the viewer gets no Node access at all. |
| Opening external links | **Removed, not guarded.** There was an unvalidated `openExternal` channel with no caller; nothing in the interface needs one, so the capability is gone. |
| Achievements | **Local only, and honest.** Derived from what you read here, never uploaded, counted once per finished book, with day arithmetic that survives daylight saving. Included because they were asked for; they are not forced on a reader who ignores them. |
| Books keyed by absolute path rather than by content digest | **Chosen** limitation; a moved or renamed book is treated as new |
| Automatic colour correction, gamma, colour boost, scaling quality, page cache | **Observed** options in CDisplayEx's catalog ("Automatic color correction", "Gamma", "Vibrance", "Lanczos (better quality)", "Linear", "Nearest (faster)", "Cache pages") |
| Colour boost implemented as a saturation matrix | **Chosen approximation**; a linear colour matrix cannot express perceptual vibrance |
| "High quality" scaling, not a Lanczos kernel | **Chosen** and labelled accordingly rather than misnamed |
| Prefetch depth defaulting to four pages | **Chosen**; CDisplayEx makes cache size a setting too |
| CBT/TAR, DjVu | **Not implemented yet**; CDisplayEx supports both |
