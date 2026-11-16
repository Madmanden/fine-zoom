// End-to-end check of Fine Zoom's zoom takeover in real Chromium.
//
// Usage: xvfb-run -a node scripts/e2e-takeover.js . [path/to/playwright-core]
//
// Needs a playwright-core install with its Chromium downloaded. Extensions
// only load in headed Chromium, hence xvfb-run on machines without a display.
// Playwright's synthetic wheel input drops some events while the page zooms,
// so the wheel check asserts whole fine steps rather than an exact count.
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const extensionDir = path.resolve(process.argv[2]);
const { chromium } = require(process.argv[3] || 'playwright-core');

const PAGE = `<!doctype html><html><head><title>t</title></head><body style="height:3000px">
<p>Hello zoom</p><textarea id="ta"></textarea>
<iframe id="fr" src="/frame" style="width:300px;height:150px"></iframe>
</body></html>`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) < 0.001;

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/frame' ? '<p>frame</p>' : PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const urlA = `http://127.0.0.1:${port}/`;
  const urlB = `http://localhost:${port}/`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fz-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sleep(500);

    const page = await context.newPage();
    await page.goto(urlA);
    await sleep(500);

    const tabIdFor = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, url);
    const tabId = await tabIdFor(urlA);
    const zoom = (id = tabId) => sw.evaluate((t) => chrome.tabs.getZoom(t), id);
    const stored = (host) => sw.evaluate(async (h) => (await chrome.storage.local.get('perSiteZoom')).perSiteZoom?.[h]?.level, host);
    const setZoomForeign = (level, id = tabId) => sw.evaluate(([t, l]) => chrome.tabs.setZoom(t, l), [id, level]);

    check('initial zoom is 1.0', near(await zoom(), 1.0), String(await zoom()));

    // 1. Key hijack on the page body.
    await page.click('p');
    await page.keyboard.press('Control+Equal');
    await sleep(300);
    check('Ctrl+= zooms one fine step', near(await zoom(), 1.05), String(await zoom()));

    // 2. Key hijack inside a text field (previously left to the browser).
    await page.click('#ta');
    await page.keyboard.press('Control+Equal');
    await sleep(300);
    check('Ctrl+= in textarea zooms one fine step', near(await zoom(), 1.10), String(await zoom()));
    const taValue = await page.$eval('#ta', (el) => el.value);
    check('textarea content untouched', taValue === '', JSON.stringify(taValue));

    // 3. HUD lives in the top frame, inside a shadow root, counter-zoomed.
    const hud = await page.evaluate(() => {
      const host = document.querySelector('fine-zoom-hud');
      return host ? { zoom: host.style.getPropertyValue('zoom'), shadow: host.shadowRoot === null } : null;
    });
    check('HUD host present in top frame', !!hud, JSON.stringify(hud));
    check('HUD counter-zoom matches level', hud && Math.abs(Number(hud.zoom) - 1 / 1.10) < 0.001, hud?.zoom);
    const frameHud = await page.frames()[1]?.evaluate(() => !!document.querySelector('fine-zoom-hud'));
    check('no HUD inside iframe', frameHud === false, String(frameHud));

    // 4. Rapid wheel steps: persisted level must equal the live level.
    await page.mouse.move(900, 600);
    await page.keyboard.down('Control');
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, -100);
    }
    await page.keyboard.up('Control');
    await sleep(900);
    const liveAfterWheel = await zoom();
    const storedAfterWheel = await stored('127.0.0.1');
    const stepsTaken = (liveAfterWheel - 1.10) / 0.05;
    check('wheel zoomed in whole fine steps', stepsTaken >= 1 && near(stepsTaken, Math.round(stepsTaken)), String(liveAfterWheel));
    check('stored level equals live level after rapid wheel', near(storedAfterWheel, liveAfterWheel), `${storedAfterWheel} vs ${liveAfterWheel}`);

    // 5. Ctrl+0 resets to default.
    await page.click('p');
    await page.keyboard.press('Control+Digit0');
    await sleep(300);
    check('Ctrl+0 resets to default', near(await zoom(), 1.0), String(await zoom()));

    // 6. Fallback: browser-applied zoom with a recent key intent gets remapped.
    await sw.evaluate((t) => markRecentZoomInputIntent(t, 'key', 'zoom-in'), tabId);
    await setZoomForeign(1.1);
    await sleep(400);
    check('browser preset step remapped to fine step', near(await zoom(), 1.05), String(await zoom()));

    // 7. Foreign change without intent (e.g. Chrome menu) is adopted and stored.
    await sleep(600);
    await setZoomForeign(1.25);
    await sleep(700);
    check('menu-style zoom kept', near(await zoom(), 1.25), String(await zoom()));
    check('menu-style zoom stored', near(await stored('127.0.0.1'), 1.25), String(await stored('127.0.0.1')));

    // 8. Settings edit while the browser remembers another level: navigation
    // must restore the extension's level, not overwrite it with Chrome's.
    await sw.evaluate(async () => {
      const { perSiteZoom = {} } = await chrome.storage.local.get('perSiteZoom');
      perSiteZoom['127.0.0.1'] = { level: 1.4, method: 'browser-zoom' };
      await chrome.storage.local.set({ perSiteZoom });
    });
    await page.goto(urlA + '?again');
    await sleep(800);
    check('navigation applies stored level', near(await zoom(), 1.4), String(await zoom()));
    check('stored level survives navigation', near(await stored('127.0.0.1'), 1.4), String(await stored('127.0.0.1')));

    // 9. Second tab on the same site: per-origin echo must not be remapped or
    // persisted as a stale value.
    const page2 = await context.newPage();
    await page2.goto(urlA + '?two');
    await sleep(600);
    await page.bringToFront();
    await page.click('p');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Control+Minus');
    await sleep(900);
    const tab2 = await tabIdFor(urlA + '?two');
    check('same-site tab follows', near(await zoom(tab2), 1.2), `${await zoom(tab2)}`);
    check('stored matches after multi-tab steps', near(await stored('127.0.0.1'), 1.2), String(await stored('127.0.0.1')));
    await page2.close();

    // 10. Other site untouched.
    const pageB = await context.newPage();
    await pageB.goto(urlB);
    await sleep(600);
    check('other site stays at default', near(await zoom(await tabIdFor(urlB)), 1.0), String(await zoom(await tabIdFor(urlB))));

    // 11. Switching the stored method to native removes content zoom.
    await sw.evaluate(async () => {
      const { perSiteZoom = {} } = await chrome.storage.local.get('perSiteZoom');
      perSiteZoom.localhost = { level: 1.3, method: 'css-zoom' };
      await chrome.storage.local.set({ perSiteZoom });
    });
    await pageB.reload();
    await sleep(800);
    const cssBefore = await pageB.evaluate(() => !!document.getElementById('fine-zoom-style'));
    check('css-zoom applied', cssBefore, String(cssBefore));
    await sw.evaluate(async () => {
      const { perSiteZoom = {} } = await chrome.storage.local.get('perSiteZoom');
      perSiteZoom.localhost = { level: 1.3, method: 'browser-zoom' };
      await chrome.storage.local.set({ perSiteZoom });
    });
    await sleep(400);
    const cssAfter = await pageB.evaluate(() => !!document.getElementById('fine-zoom-style'));
    check('css-zoom removed after switching to native', !cssAfter, String(cssAfter));
  } catch (error) {
    check('script error', false, error.stack);
  } finally {
    await context.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
