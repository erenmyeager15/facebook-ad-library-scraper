// Local regression check only. No Facebook, Apify or residential proxy requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createPageWarmup, createSearchNavigation } from '../dist/navigation.js';
import { SearchEvidenceError } from '../dist/reporting.js';

let resetSent = false;
let documents = 0;
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ads/library/' && url.pathname !== '/login/') { res.writeHead(404); res.end(); return; }
    documents += 1;
    const landing = !url.searchParams.has('q') && url.pathname === '/ads/library/';
    if (!landing && url.pathname === '/ads/library/' && !(req.headers.cookie ?? '').includes('fixture_warm=yes')) {
        res.writeHead(403); res.end('Cold fixture context'); return;
    }
    let script = '';
    if (url.searchParams.get('fixture') === 'reset' && !resetSent) {
        resetSent = true;
        script = `<script>history.replaceState(null,'','/ads/library/');window.fixtureReset=true;</script>`;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store',
        ...(landing ? { 'Set-Cookie': 'fixture_warm=yes; Path=/; SameSite=Lax' } : {}) });
    res.end(`<html><body>${url.pathname === '/login/' ? '<input name="pass">' : 'Fixture public search'}${script}</body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active&fixture=reset';
let browser;
let rejectedExternal = 0;
try {
    browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
    const warmup = createPageWarmup();
    const recoveries = [];
    const read = createSearchNavigation({ onRecovery: (value) => recoveries.push(value) });
    const fixturePage = async () => {
        const context = await browser.newContext();
        // This isolated application test intentionally intercepts every resource;
        // unlike production it makes no HTTP-cache performance assertions.
        await context.route('**/*', async (route) => {
            if (new URL(route.request().url()).origin !== origin) { rejectedExternal += 1; await route.abort(); }
            else await route.continue();
        });
        const raw = await context.newPage();
        const page = new Proxy(raw, { get(target, key) {
            if (key === 'url') return () => {
                const loaded = new URL(target.url());
                return loaded.origin === origin ? `https://www.facebook.com${loaded.pathname}${loaded.search}` : target.url();
            };
            if (key === 'goto') return async (value, options) => {
                const requested = new URL(value);
                assert.equal(requested.origin, 'https://www.facebook.com');
                return await target.goto(`${origin}${requested.pathname}${requested.search}`, options);
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        return { context, raw, page };
    };
    const first = await fixturePage();
    assert.equal(await warmup(first.page), true);
    await first.page.goto(url, { waitUntil: 'domcontentloaded' });
    await first.raw.waitForFunction(() => window.fixtureReset === true);
    assert.equal((await read(first.page, url)).url, url);
    assert.equal(recoveries.length, 1);
    // A fresh browser context shares neither cookies nor a request warm-up flag.
    const retry = await fixturePage();
    assert.equal(await warmup(retry.page), true);
    const response = await retry.page.goto(url, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    assert.equal((await read(retry.page, url)).url, url);
    await retry.raw.goto(`${origin}/login/`);
    await assert.rejects(read(retry.page, url), (error) => error instanceof SearchEvidenceError && error.reason === 'blocked');
    assert.equal(recoveries.length, 1);
    // Verify the network containment rule itself with a deliberately forbidden URL.
    await retry.raw.goto('http://forbidden.invalid/').catch(() => {});
    assert.ok(rejectedExternal > 0);
    console.log(JSON.stringify({ fixtureOnly: true, externalAccessRejected: true, freshRetryContextWarmed: true,
        exactScopeRecoveredOnce: true, loginRejected: true, documents, liveFacebookValidated: false }));
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
