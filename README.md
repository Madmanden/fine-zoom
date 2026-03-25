# Fine Zoom Extension

[![Tests](https://github.com/Madmanden/fine-zoom/actions/workflows/ci.yml/badge.svg)](https://github.com/Madmanden/fine-zoom/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/Madmanden/fine-zoom?sort=semver)](https://github.com/Madmanden/fine-zoom/tags)
[![License](https://img.shields.io/github/license/Madmanden/fine-zoom)](#license)

Fine Zoom is a Manifest V3 browser extension for native browser zoom with finer control than Chrome's built-in zoom — granular steps, per-site memory, and multiple input methods.

It supports native browser zoom and two CSS-based alternatives, with immediate in-page updates from the popup.

## Screenshot

![Fine Zoom settings page](screenshots/Screenshot.png)

The screenshot above shows the settings page, including default zoom controls and the per-site overrides list.

## Features

- Three zoom methods:
  - `browser-zoom` (default): native tab zoom via Chrome APIs
  - `font-size`: text-focused scaling using computed font-size overrides
  - `css-zoom`: page scaling using CSS `zoom`
- Per-site persistence of level and method
- Live slider preview while dragging
- Configurable popup button increment (`+` / `-`)
- Fine popup controls (`0.01`) via a dedicated small +/- row
- Ctrl/Cmd+Wheel hijack on supported pages (uses configured main step)
- Ctrl/Cmd key hijack on supported pages:
  - `Ctrl/Cmd +` zoom in (configured main step)
  - `Ctrl/Cmd -` zoom out (configured main step)
  - `Ctrl/Cmd 0` reset to default level
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
   - `Ctrl/Cmd+MouseWheel` (and trackpad pinch events emitted as modifier+wheel) use extension zoom with your configured main step on supported pages.
   - `Ctrl/Cmd +`, `Ctrl/Cmd -`, and `Ctrl/Cmd 0` are hijacked on supported pages.
4. Click Reset to return to default level.

### Settings page

Open settings from the popup.

Available settings include:
- default method
- default zoom level
- popup button step
- per-site overrides
- excluded sites
- toggle for Ctrl/Cmd+Wheel hijack
- toggle for Ctrl/Cmd key hijack

The per-site list only shows entries that differ from your current defaults.

## How It Works

- Background worker applies and persists zoom state.
- Content scripts handle CSS-based methods at `document_start`.
- Native mode uses `chrome.tabs.setZoom()` and `chrome.tabs.getZoom()`.
- Site-specific settings are stored in `chrome.storage.local`.
- In browser-zoom mode, manual native browser zoom changes are synchronized into extension state.
- Native zoom is only re-applied when the target value differs, reducing repeated zoom popups on navigation.
- Ctrl/Cmd+Wheel is intercepted in the content script and routed to the background worker for apply + persistence.
- Ctrl/Cmd key zoom shortcuts are intercepted in the content script and routed to the background worker for apply + persistence.

## Storage Keys

- `defaultMethod`
- `defaultLevel`
- `defaultPopupButtonStep`
- `perSiteZoom`
- `excludedSites`
- `enableCtrlWheelHijack`
- `enableCtrlKeyHijack`
- `didMigrateMainButtonStepTo005`

Migration flags:
- `didMigrateToBrowserZoomDefault`

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
- Trackpad pinch events are browser-dependent; Fine Zoom applies best-effort remapping and behavior may vary by browser/page.

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
├── screenshots/
│   └── Screenshot.png
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
  - `Precise browser zoom. Set exactly the zoom level you want instead of snapping to your browser's coarse preset steps. Fine-grained control via popup and modifier-key hijack with scroll wheel.`

## License

MIT
