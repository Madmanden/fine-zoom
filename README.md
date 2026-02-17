# Fine Zoom Extension

[![Tests](https://github.com/Madmanden/fine-zoom/actions/workflows/ci.yml/badge.svg)](https://github.com/Madmanden/fine-zoom/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/Madmanden/fine-zoom?sort=semver)](https://github.com/Madmanden/fine-zoom/tags)
[![License](https://img.shields.io/github/license/Madmanden/fine-zoom)](#license)

Fine Zoom is a Manifest V3 browser extension for native browser zoom with finer control than Chrome's built-in zoom — granular steps, per-site memory, and multiple input methods.

It supports native browser zoom and two CSS-based alternatives, with immediate in-page updates from the popup.

## Features

- Three zoom methods:
  - `browser-zoom` (default): native tab zoom via Chrome APIs
  - `font-size`: text-focused scaling using computed font-size overrides
  - `css-zoom`: page scaling using CSS `zoom`
- Per-site persistence of level and method
- Live slider preview while dragging
- Configurable popup button increment (`+` / `-`)
- Fine popup controls (`0.01`) via a dedicated small +/- row
- Ctrl+Wheel hijack on supported pages (fixed `0.05` increment steps)
- Ctrl key hijack on supported pages:
  - `Ctrl+` zoom in (`0.05`)
  - `Ctrl-` zoom out (`0.05`)
  - `Ctrl+0` reset to default level
- Keyboard shortcuts:
  - `Ctrl+Shift+Up` / `Cmd+Shift+Up` zoom in
  - `Ctrl+Shift+Down` / `Cmd+Shift+Down` zoom out
  - `Ctrl+Shift+0` / `Cmd+Shift+0` reset zoom
- Excluded-sites list to disable zoom on selected domains

## Installation

### Load unpacked in Chrome

1. Clone this repository.
2. Open `chrome://extensions/`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select this project directory.

## Usage

### Popup controls

1. Click the extension icon.
2. Choose a method.
3. Adjust zoom:
   - Slider step is fixed at `0.05`.
   - Main `+` / `-` use your configured popup button step (default `0.05`).
   - Fine `+` / `-` use fixed `0.01`.
   - `Ctrl+MouseWheel` (and trackpad pinch events emitted as Ctrl+Wheel) use extension zoom in fixed `0.05` steps on supported pages.
   - `Ctrl+`, `Ctrl-`, and `Ctrl+0` are hijacked on supported pages.
4. Click Reset to return to default level.

### Settings page

Open settings from the popup.

Available settings include:
- default method
- default zoom level
- popup button step
- per-site overrides
- excluded sites
- debug highlight mode
- toggle for Ctrl+Wheel hijack
- toggle for Ctrl key hijack

## How It Works

- Background worker applies and persists zoom state.
- Content scripts handle CSS-based methods at `document_start`.
- Native mode uses `chrome.tabs.setZoom()` and `chrome.tabs.getZoom()`.
- Site-specific settings are stored in `chrome.storage.local`.
- In browser-zoom mode, manual native browser zoom changes are synchronized into extension state.
- Native zoom is only re-applied when the target value differs, reducing repeated zoom popups on navigation.
- Ctrl+Wheel is intercepted in the content script and routed to the background worker for apply + persistence.
- Ctrl key zoom shortcuts are intercepted in the content script and routed to the background worker for apply + persistence.

## Storage Keys

- `defaultMethod`
- `defaultLevel`
- `defaultPopupButtonStep`
- `perSiteZoom`
- `excludedSites`
- `debugHighlightScaledText`
- `enableCtrlWheelHijack`
- `enableCtrlKeyHijack`
- `didMigrateMainButtonStepTo005`

Migration flags:
- `didMigrateToFontSizeDefault`
- `didMigrateToBrowserZoomDefault`

## Permissions

- `storage`: save local preferences on-device
- `tabs`: read and apply native tab zoom
- `scripting`: execute zoom scripts on pages when needed
- `<all_urls>` host permission: allow zoom logic to run on visited web pages

## Compatibility Notes

- Designed for Chromium browsers (Manifest V3).
- `css-zoom` uses non-standard CSS `zoom`; behavior may vary across browsers.
- Ctrl+Wheel hijack only applies where content scripts run (`http/https` pages). Restricted pages keep native browser behavior.
- Ctrl key hijack only applies where content scripts run (`http/https` pages). Restricted pages keep native browser behavior.

## Project Structure

```text
.
├── background.js
├── manifest.json
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
├── shared/
│   ├── constants.js
│   └── utils.js
└── test-logic.js
```

## Development

Run basic logic tests:

```bash
node test-logic.js
```

## Privacy

Fine Zoom does not collect, store, or transmit personal data.
The extension modifies text size locally in your browser.
Settings are stored locally using Chrome storage (`chrome.storage.local`) and never leave your device.
The extension requires page access only to apply zoom behavior on visited pages.

## Chrome Web Store Listing Notes

- Required icons included: `16x16`, `48x48`, `128x128`
- Listing requirement: provide at least one screenshot
- Suggested screenshot content: popup controls visible next to a page showing adjusted text size
- Suggested store description:
  - `Precise browser zoom. Set exactly the zoom level you want instead of snapping to your browser's coarse preset steps. Fine-grained control via popup, keyboard shortcuts, and scroll wheel.`

## License

MIT
