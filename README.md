# Amazon Quote Automation

Electron desktop app + companion browser extension (Chrome **and**
Firefox) that reads ASIN/Quantity pairs from an Excel file and adds them,
one at a time, to an Amazon Business "Request a Quote" page. It never
submits the quote, never checks out, and never stores Amazon credentials
— the extension runs inside your own, already-logged-in browser tab, and
the app just waits for you to log in if needed.

## How it works (architecture)

Chrome refuses to let any external tool (Puppeteer, remote debugging,
etc.) attach to an already-running, already-open Chrome instance — this
was verified directly, not assumed. So instead of launching a separate
browser or profile, this app is split in two:

1. **The desktop app** (`src/main.js`) runs a tiny local HTTP server
   (`src/server/localBridge.js`, bound to `127.0.0.1` only) that hands off
   a "job" (the ASIN/quantity list + quote URL) and receives progress back.
2. **The browser extension** (`extension/`) runs *inside your real
   browser* — same tab, same login, same session, nothing separate. Its
   background script polls the local server for a job; its content script
   does the actual page automation (filling ASIN/quantity, clicking Add
   Item) live in your browser.

The extension is built as Manifest V2 with a persistent background page
specifically so the **same code, unmodified**, loads in both Chrome
("Load unpacked") and Firefox ("Load Temporary Add-on") — no separate
Firefox build. `chrome.*` APIs are used throughout; Firefox implements
that namespace as a compatibility alias for the same calls.

Nothing is bypassed: login, MFA, and CAPTCHA are always handled by you,
manually, in your own browser — the extension only detects whether you're
logged in and waits if not.

## ⚠️ Before you rely on this

**The Amazon-page selectors in `extension/content.js`** were written from
inspecting the real "Manage Quotes" / "Add Items" flow earlier in
development and matched that page at the time — but Amazon can change
its markup at any point. If items stop being found, open DevTools on the
actual page and check the `SELECTORS` object at the top of that file
against the current DOM.

Also worth knowing: automating amazon.com/Amazon Business via a scripted
browser sits in a gray area against Amazon's Conditions of Use, which
generally restrict automated access. This app deliberately never bypasses
login, MFA, or CAPTCHA, and never auto-submits an order — but "manual
login + form automation" isn't the same as "sanctioned." Use it internally
with that understanding.

## One-time setup (per machine)

### 1. Install the extension

**Chrome:**
1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project's `extension/` folder
   (in a packaged build, it ships alongside the app — see Build section).
4. Confirm it shows up as "Amazon Quote Automation Bridge".

This stays installed across Chrome restarts — a one-time step.

**Firefox:**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. In the file picker, select `extension/manifest.json` directly (not the
   folder — Firefox's temporary-add-on loader wants the manifest file
   itself).
4. Confirm it shows up as "Amazon Quote Automation Bridge".

**Important Firefox limitation**: a "Temporary Add-on" is removed every
time Firefox fully restarts — you'd need to redo this step each session.
This is a Firefox restriction (unsigned extensions can't persist on
Release Firefox without a Mozilla-signed `.xpi`), not something this
project controls. For a persistent install without going through
addons.mozilla.org, you'd need Firefox Developer Edition/Nightly/ESR with
signature enforcement relaxed, or a self-distribution signed `.xpi` from
Mozilla — out of scope here, but worth knowing before relying on this in
Firefox day-to-day.

### 2. Run the desktop app

```
npm install
npm run dev
```

This starts the local bridge server (default port `47654`) and opens the
app window. The extension automatically connects to it — no manual
pairing step.

## Using it

1. Log into Amazon Business normally, in whichever browser (Chrome or
   Firefox) you'll run this in, like you always would.
2. In the desktop app: select your Excel file, review the preview, pick
   **Chrome** or **Firefox** with the radio button (must match the
   browser you loaded the extension into and logged in with), click
   **Start Automation**.
3. The extension in the selected browser opens (or reuses) an Amazon tab
   and starts filling items in — watch it happen live in your own
   browser. If the extension happens to be loaded in both browsers at
   once, only the one you picked will pick up the job — the other
   ignores it.
4. Progress streams back to the desktop app's UI in real time, per item.
5. If Amazon asks you to log in or complete a security challenge
   mid-run, the app pauses and tells you — complete it manually in the
   tab, and it resumes automatically once detected.

## Project structure

```
amazon-quote-automation/
├── package.json
├── config.json                  # quoteUrl and tunables — no credentials
├── extension/                   # Chrome + Firefox extension (same code)
│   ├── manifest.json
│   ├── background.js            # polls the local bridge, opens/finds the tab
│   └── content.js                # DOM automation + selectors — runs in your tab
├── src/
│   ├── main.js                   # Electron main process, IPC handlers
│   ├── preload.js                # contextBridge — narrow exposed API only
│   ├── renderer/                 # UI (HTML/CSS/JS)
│   ├── server/
│   │   └── localBridge.js        # local HTTP server the extension talks to
│   ├── excel/
│   │   ├── excelReader.js        # reads + validates input .xlsx
│   │   └── excelExporter.js      # writes successful-only output .xlsx
│   └── utils/
│       ├── logger.js
│       └── validation.js         # ASIN/quantity/duplicate/49-max rules
└── README.md
```

## Configuration

Edit `config.json`:

```json
{
  "quoteUrl": "https://www.amazon.com/ab/bulk-order/",
  "maxAsins": 49,
  "maxRetries": 2,
  "navigationTimeoutMs": 60000,
  "actionTimeoutMs": 15000
}
```

Set `quoteUrl` to your actual Request a Quote page URL. `maxRetries` and
`actionTimeoutMs` are passed through to the extension per job. No
credentials are ever stored in this file or anywhere else in the app.

The bridge server's port (`47654`) is currently fixed and must match the
`BASE_URL` constant at the top of `extension/background.js` — if you
change one, change the other.

## Build (Windows .exe)

```
npm run dist
```

Output: `dist/AmazonQuoteAutomation <version>.exe` (portable — no install
step). The `extension/` folder is bundled alongside it via
`extraResources` in `package.json`, so end users can point "Load unpacked"
at it without needing this repo.

**Before shipping this**, build it on Windows (or a Windows CI runner) and
verify the packaged `.exe` actually starts the local server and the
extension connects, on a clean Windows machine with Chrome installed.

## What this app deliberately does NOT do

- Does not store or ask for Amazon credentials
- Does not bypass CAPTCHA, MFA, or any Amazon security check
- Does not automatically submit the quote, check out, or enter payment info
- Does not use a database — results live in memory for the session only
- Does not silently merge duplicate ASINs — duplicates are a hard validation error
- Does not process more than 49 unique ASINs
- Does not launch a separate browser window or profile — everything runs
  in your own, already-open browser tab (Chrome or Firefox)

## Known gaps / things to verify yourself

1. `extension/content.js` selectors (see warning above) — highest priority
   if items stop being found.
2. This whole extension-bridge architecture has been verified by directly
   testing the local server's HTTP contract (job hand-off, long-polling,
   progress, stop, completion) — the actual browser extension driving a
   live Amazon tab has **not** been exercised end-to-end yet in either
   browser (requires a real Chrome/Firefox + a logged-in Amazon Business
   account to test). Load the extension and do a real run in each browser
   you plan to support before relying on this.
3. The 49-ASIN cap and retry count are configurable but currently
   hardcoded defaults in `validation.js` / `config.json` — adjust if your
   quote page's real limit differs.
4. Windows-clean-machine packaging test (see Build section) has not been run.
5. The bridge server's port (`47654`) is fixed rather than auto-negotiated
   — if that port is ever in use by something else on a user's machine,
   both `src/main.js`'s `bridge.start(47654)` call and
   `extension/background.js`'s `BASE_URL` would need to agree on a new one.
