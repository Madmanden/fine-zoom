# Text Zoom Extension

A Chrome extension for controlling text zoom level with precision. No more jumpy fonts or broken layouts!

## Features

- **Three Zoom Methods:**
  - **Browser Zoom** (default) - Native Chrome page zoom
  - **Font-Size Scaling** - Base text-size scaling for stable text-only zoom behavior
  - **CSS Zoom** - Full page scaling with minimal logic

- **Per-Domain Persistence:** Your zoom preferences are saved per website
- **No Jumpy Loading:** CSS injection happens at document start for immediate application
- **Overflow Prevention:** Content stays within viewport, no horizontal scrolling
- **Keyboard Shortcuts:**
  - `Ctrl+Shift+Up` / `Cmd+Shift+Up` - Zoom in
  - `Ctrl+Shift+Down` / `Cmd+Shift+Down` - Zoom out
  - `Ctrl+Shift+0` / `Cmd+Shift+0` - Reset zoom

## Installation

### From Source (Developer Mode)

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked"
5. Select the extension folder
6. The "Z" icon should appear in your toolbar

## Usage

### Quick Zoom (Click Icon)

1. Click the "Z" icon in your toolbar
2. Use the slider (fixed 0.05 increments) and +/- buttons (uses your configured button step)
3. Select your preferred zoom method from the dropdown
4. Click "Reset" to return to 1.0x

### Advanced Settings

Click the ⚙ gear icon in the popup to access:
- Default zoom method selection
- Default zoom level adjustment
- Per-site zoom management
- Excluded sites list
- Keyboard shortcut customization

## How It Works

### Immediate Application
The extension injects CSS at `document_start`, before the page renders, eliminating the "jumpy font" problem common in similar extensions.

### Overflow Prevention
- CSS Zoom: Browser handles scaling automatically
- Font-Size: Root/base `font-size` scaling + `word-wrap` safeguards for readability

### Storage
All preferences are stored using Chrome's `storage.local` API:
- `defaultMethod`: Default zoom method
- `defaultLevel`: Default zoom level
- `perSiteZoom`: Domain-specific zoom settings
- `excludedSites`: Sites where zoom is disabled

## File Structure

```
text-zoom-extension/
├── manifest.json          # Extension configuration
├── background.js          # Service worker for keyboard shortcuts
├── content/
│   ├── content.js        # Content script for zoom application
│   └── zoom-methods.js   # Zoom implementations
├── popup/
│   ├── popup.html        # Quick zoom UI
│   ├── popup.css         # Popup styles
│   └── popup.js          # Popup logic
├── settings/
│   ├── settings.html     # Advanced settings page
│   ├── settings.css      # Settings styles
│   └── settings.js       # Settings logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Privacy

This extension:
- ✅ Stores all data locally on your device
- ✅ Does not collect or transmit any data
- ✅ Does not require internet permissions
- ✅ Works entirely offline

### Permissions Used

- **`storage`**: To save your zoom preferences locally
- **`activeTab`**: To apply zoom changes when you click the popup or use keyboard shortcuts
- **`tabs`**: To read and set native browser zoom levels
- **`<all_urls>`**: To inject content scripts on web pages for immediate zoom application

The content script runs automatically on all web pages you visit (using `document_start` timing) to prevent the "jumpy font" effect. It only reads from storage and applies CSS - no data is collected or transmitted.

## License

MIT License

## Support

For issues or feature requests, please use the GitHub issue tracker.
