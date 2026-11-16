# Fine Zoom

[![Tests](https://github.com/Madmanden/fine-zoom/actions/workflows/ci.yml/badge.svg)](https://github.com/Madmanden/fine-zoom/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/Madmanden/fine-zoom?sort=semver)](https://github.com/Madmanden/fine-zoom/tags)
[![License](https://img.shields.io/github/license/Madmanden/fine-zoom)](#license)

Fine Zoom is a Manifest V3 browser extension for Chromium browsers that gives you exact zoom control instead of coarse built-in presets. It supports native tab zoom, text-only scaling, and CSS-based page scaling, with per-site memory and fast control from the popup, wheel, and keyboard shortcuts.

**More tools:** [christianholmdev.dk/tools](https://christianholmdev.dk/tools/)

Not yet published on the Chrome Web Store. Install manually through `chrome://extensions/` using `Load unpacked`.

## Screenshot

![Fine Zoom settings page](screenshots/Screenshot.png)

The screenshot above shows the settings page, including default zoom controls and the per-site overrides list.

## Features

- Exact zoom levels with three modes:
  - `browser-zoom` (default): native tab zoom via Chrome APIs
  - `font-size`: text-only scaling using computed font-size overrides
  - `css-zoom`: full-page scaling using CSS `zoom`
- Per-site overrides for both zoom level and zoom method
- Live slider preview while dragging in the popup
- Main `+` / `-` controls with configurable step size
- Fine adjustment controls with `0.01` increments
- Ctrl/Cmd+Wheel and Ctrl/Cmd key hijacks that defer to pages that handle the shortcut themselves, work in text fields, and match Chromium's own zoom keys on every keyboard layout
- One wheel notch is one step at every zoom level
- On-page zoom level indicator when shortcuts change the zoom
- Excluded-sites list for domains where zoom should stay untouched

## Installation

### Load unpacked in Chrome

1. Clone this repository.
2. Open `chrome://extensions/`.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select this project directory.

## Usage

### Popup controls

1. Click the extension icon.
2. Choose a zoom method.
3. Adjust the level:
   - The slider uses a fixed `0.05` step.
   - Main `+` / `-` buttons use your configured popup step, defaulting to `0.05`.
   - Fine `+` / `-` buttons use a fixed `0.01`.
   - `Ctrl/Cmd+MouseWheel` and trackpad pinch gestures on supported pages use your configured main step.
   - `Ctrl/Cmd +`, `Ctrl/Cmd -`, and `Ctrl/Cmd 0` are intercepted on supported pages unless the page handles the key itself. `Ctrl/Cmd 0` resets to your default level.
4. Click `Reset` to return to the default level.

### Settings page

Open settings from the popup to manage defaults and saved overrides.

Available settings include:
- default method
- default zoom level
- popup button step
- fine step
- per-site overrides
- excluded sites
- toggle for Ctrl/Cmd+Wheel hijack
- toggle for Ctrl/Cmd key hijack
- toggle for the on-page zoom level indicator

The per-site list only shows entries that differ from your current defaults, so it stays focused on real overrides instead of every saved site.

## How It Works

- Background worker applies and persists zoom state.
- Content scripts handle CSS-based methods at `document_start`.
- Native mode uses `chrome.tabs.setZoom()` and `chrome.tabs.getZoom()`.
- Site-specific settings are stored in `chrome.storage.local`.
- In browser-zoom mode, manual native browser zoom changes (for example from the Chrome menu) are synchronized into extension state.
- The extension's stored level is the source of truth. Chrome also remembers zoom per site, and when it restores an outdated level during navigation, Fine Zoom puts the stored level back instead of saving Chrome's value.
- Stored native zoom is applied as soon as the top-level document starts, not only when the page has fully loaded.
- Native zoom is only re-applied when the target value differs, reducing repeated zoom popups on navigation.
- The background worker tracks every level it asked the browser to apply per site, so the echoes of its own changes (rapid steps, other tabs of the same site) are never mistaken for user changes.
- Ctrl/Cmd+Wheel is intercepted in the content script and routed to the background worker for apply + persistence. Wheel movement is scaled by the current browser zoom, so one wheel notch is one step at every zoom level.
- Ctrl/Cmd key zoom shortcuts are intercepted in the content script and routed to the background worker for apply + persistence. Keys are matched the way Chromium matches its own zoom shortcuts (virtual key codes), so they work on any keyboard layout.
- Shortcut interception is polite: it observes input in the capture phase but only acts in the bubble phase, so pages that call `preventDefault()` keep their own behavior. If the browser still applies native zoom despite the input, the change is remapped to your configured step, and `Ctrl/Cmd 0` maps to a reset even on that path.
- Repeated key presses are batched, so holding a shortcut does not queue a long tail of zoom steps.
- Per-site levels from streamed input are written to storage at most every 300 ms, because every storage write is broadcast to every open frame.
- An optional on-page indicator shows the new level whenever a shortcut changes the zoom, including remapped browser zoom. It is drawn once in the top frame, isolated in a shadow root, and keeps the same size at every zoom level.

## Storage Keys

- `defaultMethod`
- `defaultLevel`
- `defaultZoomStep`
- `defaultFineZoomStep`
- `defaultPopupButtonStep` (legacy alias kept in sync with `defaultZoomStep`)
- `perSiteZoom`
- `excludedSites`
- `enableCtrlWheelHijack`
- `enableCtrlKeyHijack`
- `enableZoomHud`
- `didMigrateMainButtonStepTo005`

Migration flags:
- `didMigrateToBrowserZoomDefault`
- `didMigrateRemovePerSite100`

## Permissions

- `storage`: save local preferences on-device
- `tabs`: read and apply native tab zoom
- `scripting`: execute zoom scripts on pages when needed
- `<all_urls>` host permission: allow zoom logic to run on visited web pages

## Compatibility Notes

- Designed for Chromium browsers (Manifest V3).
- `css-zoom` uses non-standard CSS `zoom`; behavior may vary across browsers.
- Native zoom cleanup skips restricted and error pages that cannot be scripted.
- Ctrl/Cmd+Wheel hijack only applies where content scripts run (`http/https` pages). Restricted pages keep native browser behavior.
- Ctrl/Cmd key hijack only applies where content scripts run (`http/https` pages). Restricted pages keep native browser behavior.
- Pages that handle a shortcut themselves win over the hijack; Fine Zoom only remaps the resulting native zoom change if the browser still handles it.
- Zoom shortcuts are also handled while a text field has focus, since they have no editing meaning there. Editors that bind them call `preventDefault()` and keep their behavior.
- Trackpad pinch events are browser-dependent; Fine Zoom applies best-effort remapping and behavior may vary by browser/page.

## Project Structure

```text
.
├── background.js
├── manifest.json
├── docs/
│   └── HANDOFF.md
├── content/
│   ├── content.js
│   └── zoom-methods.js
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── settings/
│   ├── settings.html
│   ├── settings.css
│   └── settings.js
├── screenshots/
│   └── Screenshot.png
├── scripts/
│   ├── e2e-takeover.js
│   └── generate_icons.py
├── shared/
│   ├── constants.js
│   ├── messaging.js
│   └── utils.js
└── test-logic.js
```

## Development

Run basic logic tests:

```bash
node test-logic.js
```

Run the end-to-end zoom takeover check in real Chromium (needs a `playwright-core` install with its Chromium; extensions only load headed, so use `xvfb-run` without a display):

```bash
xvfb-run -a node scripts/e2e-takeover.js . path/to/node_modules/playwright-core
```

## Privacy

Fine Zoom does not collect, store, or transmit personal data.
The extension modifies text size locally in your browser.
Settings are stored locally using Chrome storage (`chrome.storage.local`) and never leave your device.
The extension requires page access only to apply zoom behavior on visited pages.

## Chrome Web Store Listing Notes

- Required icons included: `16x16`, `48x48`, `128x128`
- Listing requirement: provide at least one screenshot
- Suggested screenshot content: the popup or settings page shown beside a page with visible zoom changes
- Suggested store description:
  - `Precise browser zoom for Chromium browsers. Set the exact zoom level you want instead of snapping to coarse browser presets. Fine-grained control via popup, wheel, and keyboard shortcuts.`

## License

MIT
