# Text Zoom Extension

A Chrome extension for controlling text zoom level with precision. No more jumpy fonts or broken layouts!

## Features

- **Three Zoom Methods:**
  - **CSS Zoom** (default) - Simplest approach, minimal layout disruption
  - **Font-Size Scaling** - More granular control with overflow prevention
  - **Transform Scale** - GPU-accelerated, smooth performance

- **Per-Domain Persistence:** Your zoom preferences are saved per website
- **No Jumpy Loading:** CSS injection happens at document start for immediate application
- **Overflow Prevention:** Content stays within viewport, no horizontal scrolling
- **Keyboard Shortcuts:**
  - `Ctrl+Shift+Equal` / `Cmd+Shift+Equal` - Zoom in
  - `Ctrl+Shift+Minus` / `Cmd+Shift+Minus` - Zoom out
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
2. Use the slider (0.05 increments) or +/- buttons
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
- Font-Size: `max-width: 100vw` + `word-wrap: break-word` on all text elements
- Transform: Viewport width adjustment + `transform-origin: top left`

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
│   └── zoom-methods.js   # Three zoom implementations
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
- ✅ Only accesses the active tab when you interact with it

## License

MIT License

## Support

For issues or feature requests, please use the GitHub issue tracker.