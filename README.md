# UI Documentation Engine

Explores an enterprise web application (SAP Fiori/UI5), interacts with every
relevant control, captures screenshot evidence, and assembles a Word document
matching the format of the hand-made comparison documents.

> **For anyone using this from a browser once it's hosted: you need nothing
> installed.** No Node.js, no Chrome/Edge, no account, no extension — not on
> your own computer. Just open the server's URL in whatever browser you
> already have. Node.js and a browser are required only on the one machine
> that *runs* the server — see [Requirements](#requirements).

## How it works

Two stages, with a durable artifact between them:

```
config/apps/<app>.yaml
        │
        ▼
   CAPTURE  ──►  output/runs/<runId>/{trace.json, screenshots/}
   (drives the browser, one run per version)
        │
        ▼
   ASSEMBLE ──►  output/<Title>.docx
   (pure function of the trace; never opens a browser)
```

- **Capture** drives a real browser against one version of the application and
  writes everything it saw to disk (`trace.json` + screenshots) — nothing
  about document formatting happens here.
- **Assemble** reads that trace and builds the `.docx`. It never opens a
  browser, so formatting can be fixed and the document regenerated without
  repeating a slow capture run.

### Browser automation layer

The engine talks to Chrome/Edge directly over the Chrome DevTools Protocol
(CDP) — no Playwright, no Puppeteer. `src/automation/` holds that layer:

| Module | Role |
|---|---|
| `chrome-launcher.ts` | Finds and launches the installed browser, returns its CDP WebSocket |
| `cdp-client.ts` / `cdp-session.ts` | Protocol transport and per-target sessions |
| `page-shim.ts` / `locator-shim.ts` | A small Playwright-shaped API (`page.locator(...).click()`) over raw CDP |

- The shims keep the interaction code readable and framework-agnostic.
- `locator-shim.ts` implements the parts of Playwright's selector syntax the
  interaction layer relies on — `:visible`, `:has-text()`, `:text-is()` —
  because plain `querySelectorAll` rejects them as a syntax error.
- `:text-is()` matches the *smallest* element holding the text (following
  Playwright's own behavior), and dialog actions are clicked on the element
  that actually owns the click handler (a `button`, or an
  `li[role="option"]`) — never a text node nested inside it.
- `npm run check:selectors` is a standalone regression check for this engine
  — see [Verifying against the fixture](#verifying-against-the-fixture).

### What becomes a documentation point

A control earns a label + screenshot when it is one of:

- a **dropdown**
- a **calendar**
- a **value help / lookup**
- a **multi-select**
- a **checkbox or radio**
- a **file upload**
- a **button that reveals new UI** (dialog, popup, page)

Deliberately excluded:

- **Plain text inputs and textareas** — still located, filled, and committed
  (so dependent fields react and the form reaches a realistic state), but earn
  no screenshot of their own. A filled text field adds nothing the page's
  closing "Full Page" capture doesn't already show, and one point per text
  field would bury the interactions that actually matter.
- **Read-only / display-only fields** — not interactive, so not evidence.
- **Pure action buttons** (Save, Search, Execute) — nothing visible changes,
  so there's nothing to photograph.
- **Dialog dismissal buttons** (OK, Cancel, Close) — clicking them tears down
  the state being documented.

For controls that open an overlay, **the opened state is the evidence** — the
screenshot is taken with the dropdown expanded or the lookup dialog visible,
before a value is chosen, matching what a human tester would actually see.

### Slow-loading applications

- Enterprise Fiori apps commonly need **20–100 seconds** before their content
  exists: the launchpad shell paints almost immediately, then the component
  loads, the route resolves, and data is fetched.
- Capturing on a fixed delay would photograph an empty shell, so the engine
  instead waits on what has actually rendered — interactive controls or a
  dialog present, nothing busy, control count no longer changing.
- Bounded by `budgets.appReadyTimeoutMs` (default 3 minutes).

### Dialogs

Two kinds are treated differently:

- **Message dialogs** (`Error: Both Account Group and Sales Org is
  mandatory`, only an OK button) are incidental — the engine clicks OK and
  moves on. Never documented. Also cleared between fields, since one field's
  validation message would otherwise block every control behind it.
- **Chooser dialogs** (`Customer Category: Organization / Person`) are a
  branch point — see [Branching](#branching).

### Full-page capture

- A whole-page capture is **consecutive viewport-sized screenfuls**, not one
  tall image — matching the reference documents exactly (one of their "Full
  Page" points is twelve consecutive screenshots). This isn't just stylistic:
  every image is embedded at a fixed width, so one long capture of a long form
  would shrink into an illegible strip.
- Fiori usually scrolls an inner container, not the window, so the engine
  locates whatever actually scrolls rather than calling `window.scrollTo`
  (which would just photograph the same screenful repeatedly).
- **Capture happens per section, not once at the end.** As each section
  finishes (Form Section, then Copy Section, ...) the page is photographed
  top-to-bottom immediately, while that section's own values are still on
  screen. Those batches are cumulated into the page's single `Full Page`
  point, in processing order.
- **Why:** photographing once after *all* sections finished — the earlier
  behavior — left a window where the form could change underneath the camera.
  A production run showed the exact cost: a branch's `Full Page` image was
  byte-for-byte identical to that branch's opening screenshot, because a
  chooser dialog had been reopened by a later section's own value-help and was
  still covering the form at the moment of the single closing shot. The filled
  form was never photographed at all.
- Applies to both Manual and Automatic data-entry modes — same section
  processing, no mode-specific path.

### UI5 id churn

- UI5 gives a view without an explicit id an auto-generated prefix from a
  global counter — `__xmlview2--DueDateId`, `__xmlview2--BPGrpId`.
- That number is assigned when the view instance is created, so
  re-instantiating the view renumbers it to `__xmlview3--…`, and **every
  id-based selector captured beforehand silently matches nothing**. On a real
  run this surfaced as a long list of "element not present" skips for fields
  that were plainly on screen.
- **Fix:** every control also carries a second, view-independent selector
  built from the application-authored part of its id
  (`[id$="--DueDateId-inner"]`). That form is preferred whenever it identifies
  exactly one element.
- A locator is resolved at action time, not when it's built, so a
  view-number-free selector stays correct even if the view renumbers between
  resolution and the click/fill that follows — a race that otherwise fails a
  field which was on screen the whole time.
- The exact id is used instead when the suffix matches several elements (two
  view instances briefly mounted together).
- Ids with no `--` prefix (`SalesAreaDialog-cancel`) are application-authored
  already and need no fallback.

### Loading overlays

- A value-help dialog opens before its rows arrive — busy indicator, then a
  placeholder row.
- The engine waits for the overlay's contents to settle before photographing
  or selecting, so the evidence always shows real data and the chosen value is
  a real one — never the `Loading......` placeholder or a growing-list `More`
  trigger.

### Editability checking

- Every interaction (click, fill, toggle) is preceded by a fast check: is the
  control present, visible, enabled, not read-only, not covered by anything?
- **Why:** a real production failure — one field's dropdown left an overlay
  open that never fully closed, and every field behind it (correctly located,
  genuinely fillable once the overlay cleared) separately burned its full
  30-second action timeout for the same underlying reason. 16 fields like that
  cost minutes; the same run now fails each one in about 3 seconds. See
  `budgets.editabilityCheckMs`.
- A blocked control gets one attempt at clearing whatever covers it (the
  common case) before the check gives up.
- Still not interactable → the control is skipped quietly, not as an
  exception (it never became fillable, rather than failing while being
  filled), and capture continues.
- A dialog with no working Close/OK/Escape is detected the same way —
  dismissal is verified, not assumed, so an undismissable dialog is logged
  once and left alone rather than retried on every page sweep.

### Staying inside the application

Two guards keep exploration anchored to the application being documented:

- **Shell chrome is never discovered.** Anything inside the Fiori Launchpad's
  `#shell-header` (Home, search, notifications, user menu) is skipped by both
  discovery probes — it appears on every page of every application and
  belongs to none of them.
- **Navigation is scope-checked.** The run is anchored to the semantic object
  of its entry URL (`#RequestCustomerExtended-...` → `RequestCustomerExtended`).
  A link landing on a different one has left the application — it's still
  captured as a documentation point, but never recursed into.
- **Why both exist:** without them, a real run followed the shell's Home icon
  into the app launcher, opened an unrelated application from a tile, and
  bounced Home → tile → Home → tile until the browser crashed, none of it
  belonging in the document.
- When every recovery strategy fails, `backtrack()` finally reloads the
  application's entry link. It still reports failure (this is a different page
  from the one wanted, so the caller must not carry on interacting), but it
  leaves the browser somewhere known and in-scope rather than wherever a
  runaway navigation ended up.

### Navigation safety

- Returning to a page — after a branch, a tab, or a link that navigated away
  mid-page — is **verified, not assumed**.
- `backtrack()` checks the destination against the target's fingerprint,
  title, and URL, escalating: history back → history back again → direct URL
  navigation → hard reload, verifying after each attempt.
- If none succeed, exploration of that page's remaining branches stops rather
  than risk interacting with an unknown page. Applies equally to a failed tab
  return and to a link that jumped to a full new page mid-form.

### Complete exploration

- Every interactive element is discovered, not just form fields: buttons,
  links (`<a>`, `role="link"`), menu items, tabs, toggles, checkboxes/radios,
  dropdowns, and expandable sections (`aria-expanded`, `<details>`).
- A link or menu item that navigates to a genuinely different page is explored
  as a full child page — captured, its own controls processed, its own
  branches followed — then the engine verifies its way back before touching
  anything else on the page that link was found on.

### Hierarchical document

The generated `.docx` uses real Word heading styles, not a flat label list:

```
H1  Application title
H2  Version ("Old Version" / "New Version")
H3  Page or top-level branch (a chooser option, a tab)
H4  Sub-page or dialog reached from that page
—   Interaction points (label + screenshot) as body content
```

- A simple, non-branching page produces no H3/H4 at all — its points sit
  directly under H2, matching the reference documents' flat layout exactly.
- Nesting beyond H4 falls back to a bold paragraph rather than an invalid
  heading jump.
- The tree is built from each evidence item's `workflowPath` and validated
  (`src/document/tree.ts`) — orphaned or misattributed nodes are logged as
  warnings, never silently produce a wrong document.

### Branching

- When a dialog offers two or more real alternatives, each one leads to a
  different workflow, and **all of them are documented**.
- For every option: the engine captures the open dialog labelled with that
  option, takes the branch, explores it to completion, then reloads the
  application to bring the chooser back and takes the next one.
- This reproduces the reference documents exactly — a workflow opens with a
  point such as `Organization` showing the category dialog, followed by that
  branch's own fields and its `Full Page`.

### Safety

- The engine drives a real business system with dummy data, so buttons
  matching `safety.denyLabels` (Save, Submit, Post, Approve, Delete, …) are
  **never clicked**.
- Such buttons yield no documentation point anyway, so refusing to click them
  costs the document nothing.
- `safety.allowLabels` (Search, Execute, Go) are read-only queries and are
  permitted.

## Requirements

**These apply only to the one machine running the server — not to the people
using it.**

For everyone else, using the web interface from their own computer once it's
hosted:

- **No Node.js.**
- **No Chrome or Edge install of their own** — any browser they already have
  works.
- **No account, no extension, no dependency of any kind.**
- Just a browser pointed at the server's address.
- This works because the served page itself has **zero external
  dependencies** — no CDN scripts, no fonts, nothing fetched from the
  internet — so it behaves identically on a locked-down corporate machine.

See [Running as a shared server](#running-as-a-shared-server) for the one
extra thing the *host* machine needs so other people can reach it (a firewall
rule) — unrelated to what those people need on their own side.

What the host machine itself needs:

| Requirement | Why |
|---|---|
| **Node.js ≥ 20** | Runs the engine and the web server |
| **Google Chrome _or_ Microsoft Edge** | Driven directly over the Chrome DevTools Protocol |

- **No browser download step.** The engine doesn't bundle or fetch a browser —
  it launches whichever Chrome or Edge is already installed, in that order of
  preference, searching standard install paths and falling back to the
  Windows registry (`src/automation/chrome-launcher.ts`).
- Edge is Chromium-based and speaks the same protocol, so a stock Windows
  machine with no Chrome installed works unchanged.
- If neither is found, startup fails immediately with `Chrome or Edge not
  found`.
- Nothing else is needed — no ChromeDriver, no Playwright/Puppeteer browser
  binaries, no Docker. CDP is served by the browser itself over a WebSocket
  the launcher opens with `--remote-debugging-port=0`.

## Setup

```bash
npm install
```

## Web interface

```bash
npm run serve
```

- Open <http://localhost:5173>, paste one or both URLs, press **Generate
  Document**.
- Leave a column empty to document only that one version.
- **Sign-in is handled for you:** before any capture starts, the engine
  checks each site headlessly; any site presenting a sign-in screen gets a
  live view shown in the page, and the engine waits. Capture runs
  automatically once every sign-in is complete.
- Sessions are saved under `auth/.storage/<browser>/<origin>.json`, keyed by
  *browser* first, then origin (see [Running as a shared
  server](#running-as-a-shared-server) for why) — so a host is signed in to
  once per browser and reused afterwards, and two versions on the same host
  only need one sign-in.
- The live view is embedded in the page, and can also be opened in its own
  tab at `/live/jobs/<jobId>` (the Progress log prints this link when a
  sign-in begins) — a better surface for SSO flows involving a password
  manager, a certificate prompt, or MFA.
- Either view forwards clicks and typing to the real browser and closes
  itself once the session is saved. An expired session mid-capture reopens
  the same flow and retries the capture.
- URLs can be prefilled for sharing:
  `http://localhost:5173/?old=<encoded>&new=<encoded>`

### Running as a shared server

- `server.listen(port)` binds every network interface by default, so it's
  reachable from other machines the moment it starts — the startup log prints
  the LAN address(es) alongside `localhost` for exactly this reason. Point a
  team at one machine's address instead of everyone running their own copy.

**Each browser gets its own session — no cross-user leakage.**
- The first request sets an opaque, `HttpOnly` id cookie
  (`src/server/userId.ts`), with no login of its own.
- Every saved-session path is namespaced under it:
  `auth/.storage/<id>/<origin>.json`.
- **Why:** without this, sessions were keyed by origin alone — the first
  person to sign in to a host would silently sign in *for every later job from
  every other user* against that host, each one running under that first
  person's identity with no indication it happened.
- With the cookie, two people at two browsers hitting the same shared server
  get two independent SAP sessions, never each other's.
- This does **not** gate who can reach the server or start a job — anyone who
  can reach the address can use it, same as any other tool run on a trusted
  internal network with no login screen of its own.

**Windows Firewall must allow it in.**
- Binding every interface makes the server reachable *from this machine*, but
  a request from a genuinely different machine still passes through Windows
  Firewall first, which blocks unrecognised inbound connections by default.
- Confirmed on a real deployment: no allow rule for Node existed at all, plus
  an active **block** rule for it on the Public profile (left over from an
  earlier "Block access" click on Windows' own connect-time prompt).
- **Fix:** `install-service.ps1` adds an inbound allow rule scoped to the
  **Private** profile (see below) whenever it's run elevated. Run it elevated,
  or add the rule by hand:

```powershell
New-NetFirewallRule -DisplayName "UI Documentation Engine (port 5173)" `
  -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private
```

- Check which profile a network is on with `Get-NetConnectionProfile` before
  relying on this — scoping to Private only opens the port on networks
  Windows already considers trusted (a corporate LAN), not on public/guest
  Wi-Fi, even from the same machine.

**Keeping it running.**
- A plain `npm run serve` stops the moment its terminal closes or the process
  dies for any reason, with nothing bringing it back until someone notices.
- `scripts/run-server.ps1` wraps it in a restart loop and logs to
  `logs/server-<date>.log` (there's no terminal for an unattended process to
  print to).
- `scripts/install-service.ps1` registers that wrapper as a Windows Scheduled
  Task so it starts on its own — using only what Windows already ships, no
  new service-manager dependency for the host or the people using it.

```powershell
# Starts the server whenever you log in to this machine. No elevation needed
# for the task itself, but run this elevated too if you want the firewall
# rule added automatically — otherwise add it by hand (see above).
.\scripts\install-service.ps1

# Starts at boot, as SYSTEM, before anyone logs in — genuinely unattended.
# Run this one from an elevated ("Run as Administrator") PowerShell; the
# firewall rule is added as part of the same elevated run.
.\scripts\install-service.ps1 -AtStartup

# Remove the scheduled task (auth/.storage/, output/ and logs/ are untouched).
.\scripts\uninstall-service.ps1
```

- Starting a second instance on a port already in use fails with a clear
  `port 5173 is already in use` message and a non-zero exit code, rather than
  a raw stack trace — useful when `install-service.ps1` is about to be pointed
  at a port someone left a manual `npm run serve` running on.

## Command line

Create `config/apps/<app>.yaml` (copy `config/apps/example.yaml`), then:

```bash
# 1. Sign in once per version; the session is saved and reused.
npm run login -- --app <app> --version-id new

# 2. Capture each version independently.
npm run capture -- --app <app> --version-id old
npm run capture -- --app <app> --version-id new

# 3. Build the document from the most recent runs.
npm run assemble -- --app <app>
```

Or all of it in one go:

```bash
npm run run -- --app <app>
```

- Useful flags: `--headed` to watch the browser, `--verbose` for per-control
  logging, `--out <path>` to choose the output file.
- Applications reachable without a login (for example IP-allowlisted hosts)
  can set `requiresAuth: false` and skip step 1.

## Configuration

| File | Purpose |
|---|---|
| `config/apps/<app>.yaml` | URLs, safety policy, budgets, per-app overrides |
| `config/lexicon.yaml` | Canonical label names |
| `config/testdata.yaml` | Dummy values by label and by control kind |

- **The lexicon is what keeps the two versions aligned.** Old and New are
  explored independently, so an unchanged field only produces an identical
  document entry in both if its label resolves the same way in both runs.
- Value-help fields intentionally have no dummy value — the engine opens the
  lookup and selects a real row, so the value is always valid in the target
  system.
- Dates support `today` and relative offsets (`+30d`, `-1m`, `+1y`), and
  ranges as `today..+30d`, so a start date is never after its end date.

## Output

```
output/
├── runs/<runId>/
│   ├── screenshots/        numbered in capture order
│   ├── trace.json          evidence records — the assembly stage's input
│   └── report.json         internal audit: pages, exceptions, budget stops
└── <Title>.docx            the deliverable
```

- `report.json` holds everything internal — exception records, skipped
  buttons, budget stops.
- None of it appears in the document, which contains only labels and
  screenshots.

## Verifying against the fixture

`config/apps/fixture.yaml` points at a local page containing every control
kind, a read-only field, and a Save button that must never be clicked:

```bash
npm run run -- --app fixture
```

- Expect **16 documentation points** per version, **0 exceptions**, and a Full
  Page screenshot with all fields populated and **no** "RECORD SAVED" text.

```bash
npm run check:selectors
```

- A narrower, faster check of just the selector engine
  (`src/automation/locator-shim.ts`) — the `:visible`, `:text-is()`, and
  `:has-text()` pseudo-classes — against the exact selectors the
  dialog/chooser code uses.
- Lives outside `src/` (`tools/dev-checks/`), so it never ships in `dist/`.
- Run it after touching selector resolution.

## Troubleshooting

- **The document has few or no points, and the screenshots look empty.** The
  application hadn't finished rendering. Raise `budgets.appReadyTimeoutMs` and
  re-run; the verbose log prints `ready after Ns (interactive=…, dialogs=…)`,
  showing what had actually appeared.
- **The page title in the log is the launchpad's, not the application's.**
  Same cause: the launchpad shell painted before the route resolved. Readiness
  waiting handles this, but a very slow host may need a larger budget.
- **A branch was skipped with "could not return to the branch point".** The
  engine reloads the entry URL to bring an entry dialog back. If the
  application doesn't present the chooser again on reload, that branch can't
  be reached automatically.
- **Everything failed with "Element is not an `<input>`".** A control's
  selector resolved to a wrapper rather than its editable element. The engine
  resolves UI5 wrappers automatically; report the control type if a custom
  control still fails.
- **Points appear that should not, or vice versa.** Use `excludeLabels` to
  drop a structurally-interactive control that isn't a meaningful point.
  Read-only fields, action buttons, and dialog OK/Cancel buttons are already
  excluded.

## Notes and limits

- **Native `<select>`** elements render their list in the operating system's
  own layer, which can't be screenshotted — the engine sets a valid option and
  photographs the result instead. SAP Fiori dropdowns render in the DOM and
  take the normal opened-state path.
- **Loop detection** fingerprints the UI5 control tree first and the URL
  second, because Fiori commonly keeps one URL across many application
  states.
- **Budgets** (per-control timeout, per-page control cap, page cap, depth cap,
  wall-clock cap) bound every run; any that triggers is recorded in the
  report.
- Controls that can't be automated are recorded as exceptions with a
  screenshot rather than silently skipped.
- A control with **no resolvable label** is still filled, so the closing
  full-page capture shows a complete form, but produces no point of its own —
  every point in the reference documents is identified by its label.
- Returning to a branch point **fully reloads** the application. Navigating
  to a URL that differs only by its hash is a same-document navigation and
  would leave a single-page application exactly where it is.
