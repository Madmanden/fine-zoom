# Handoff

Branch: `main`. Released as version 1.2.0 (manifest), tagged `v1.2.0` on the
release commit directly after `fceb768`, and pushed to `origin`. As before,
distribution is a manual "Load unpacked" install; there is no Web Store
listing and no GitHub Release.

## What changed and why

The work makes the takeover of browser zoom more reliable. The details are in
`README.md` ("How It Works").

- **Own-change tracking** (`background.js`, `shared/utils.js`): replaced the
  one-slot-per-tab "expected zoom" with a per-site list that does not consume
  entries (`recordExpectedZoomLevel` / `matchesExpectedZoomLevel`). Before,
  fast steps made the extension treat its own earlier `setZoom` events as user
  changes. It then saved a stale level or added an extra step. Native zoom is
  per-origin, so matching per site also covers the echo in other tabs.
- **Stale-event guard**: changes that did not come from the extension are only
  adopted or stored if the tab's live zoom still equals the event's level.
- **Navigation**: between `loading` and `complete`, a zoom change that did not
  come from the extension and has no input intent is Chrome restoring its own
  per-site memory. The stored level is now put back instead of being saved.
  Before, a level edited on the settings page was overwritten on the next
  visit (reproduced on the old code). Stored native zoom is also applied when
  the top-level document starts (`documentStarted` message), not only at
  `complete`.
- **Fallback**: removed the 120 ms sleep and the "recent wheel hijack" check.
  A 60 ms wait for a late input intent remains, only when there is no intent
  yet and the tab is not navigating.
- **Text fields**: zoom shortcuts are now caught in inputs and textareas as
  well, with no browser preset jump and remap afterwards.
- **Keys**: `resolveZoomCommand` (utils) matches Chromium's virtual key codes
  (`keyCode`) and falls back to `key` only for IME and synthetic events. This
  fixes Ctrl+ß (German) and Ctrl+Insert being treated as zoom keys.
- **Wheel**: the content script sends raw CSS-px deltas. The background scales
  them by the real browser zoom, because Chromium divides wheel deltas by the
  zoom. Before, one notch at 200% gave half a step, and at 50% it gave two
  steps. The remainder resets after 600 ms of no input.
- **Speed**: native steps no longer send a content-zoom cleanup to every frame
  (the content script now removes content zoom itself when stored settings
  switch the site to native), and no longer call `getZoom` twice around
  `setZoom`. Per-site writes are throttled to every 300 ms and merged into the
  latest stored map (`applyPendingSiteUpdates`), and they are flushed on
  navigation.
- **Indicator**: drawn only in the top frame, sent by the background for direct
  and fallback changes, in a closed shadow root built with DOM APIs (safe with
  Trusted Types), and counter-zoomed so it keeps the same size at every level.

## Verification

- `node test-logic.js`: all pass, with new tests for key resolution,
  own-change tracking and pending-update merging.
- ESLint `no-undef` / `no-unused-vars` over background, content and utils:
  clean.
- `xvfb-run -a node scripts/e2e-takeover.js . <playwright-core>` with
  playwright-core 1.62.1 / Chromium 151: 20/20 on the new code. The same
  script on the old `fceb768` gave 11/20 (text field, indicator, navigation
  overwrite, switching to native, and the follow-on multi-tab steps).
- A one-off wheel trace: 8 notches from 100% give 11 steps (800 device px /
  70), independent of zoom.

## Known limitations and skipped checks

- Not tested by hand in desktop Chrome with a real mouse, trackpad or Mac.
  Trackpad pinch was not tested at all.
- Pinch still moves in configured steps, not continuously. This is a
  deliberate product choice and was left unchanged.
- Chrome menu zoom and pages without content scripts (Web Store, PDF viewer)
  still use Chrome's preset steps. A neighbour-preset heuristic was considered
  and left out as too uncertain.
- A browser zoom to a level the extension itself set within the last second is
  treated as the extension's own change and is not stored. This is a rare edge
  case.
- The e2e wheel check asserts whole fine steps only, because Playwright's
  synthetic wheel drops events while the page zooms.

## Next steps

1. Test by hand in Chrome: wheel at 50% and 200%, Ctrl+/- in Google Docs and
   VS Code web (they must keep their own shortcuts), Danish and German
   layouts, trackpad pinch.
2. Optional: add the e2e script to CI (needs Chromium and xvfb).
