// Build-time compatibility smoke check. No external requests or Apify storage.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const [major, minor, patch] = process.versions.node.split('.').map(Number);
assert(major === 24 && (minor > 22 || minor === 22 && patch >= 1), 'Patched Node 24.22.1 or later in the 24.x line is required');
assert.equal(require('playwright/package.json').version, '1.64.1', 'Playwright must match the pinned browser image');

const browser = await chromium.launch({ headless: true, timeout: 15000, args: ['--no-sandbox'] });
try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let externalAttempts = 0;
    await context.route('**/*', async route => { externalAttempts += 1; await route.abort(); });
    const page = await context.newPage();
    await page.setContent('<!doctype html><title>Browser compatibility</title><main>ready</main>');
    assert.equal(await page.locator('main').innerText(), 'ready');
    assert.equal(externalAttempts, 0);
    console.log(JSON.stringify({ node: process.version, playwright: require('playwright/package.json').version,
        browser: browser.version(), externalRequests: externalAttempts, containerSmokePassed: true }));
    await context.close();
} finally {
    await browser.close();
}
