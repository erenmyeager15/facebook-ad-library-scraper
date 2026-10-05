// Offline regressions for the failure paths found on 5 October.
// Synthetic browser fixtures only: no Apify run or public requests.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { log, LogLevel, Request } from 'crawlee';
import { createRouter, parseEmbeddedAdRecords } from '../dist/routes.js';
import { RunReporter, inspectSearchEvidence } from '../dist/reporting.js';

log.setLevel(LogLevel.ERROR);
const searchUrl = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active';
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const ad = {
    ad_archive_id: '123456789', page_id: '15087023444', page_name: 'Nike',
    snapshot: { page_name: 'Nike', body: { text: 'Nike fixture running shoes' },
        images: [{ original_image_url: 'https://fixture.invalid/creative.png' }],
        videos: [{ video_sd_url: 'https://fixture.invalid/creative.mp4',
            video_preview_image_url: 'https://fixture.invalid/creative.png' }] },
};
const payload = { ad_library_main: { search_results_connection: {
    edges: [{ node: { collated_results: [ad] } }], count: 1,
    page_info: { has_next_page: false },
} } };
const baseHtml = `<!doctype html><html><body>
<img width="80" height="80" src="${pixel}">
<script type="application/json">${JSON.stringify(payload)}</script>
</body></html>`;
const browser = await chromium.launch({ headless: true });
const results = [];
try {
    for (const scenario of ['control', 'offscreen_lazy_image', 'unrelated_pending_image']) {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        let interceptedRequests = 0;
        // All external requests are intercepted; none reaches a server.
        await context.route('**/*', async (route) => {
            interceptedRequests += 1;
            if (route.request().url() === 'https://fixture.invalid/pending.png') return;
            await route.abort();
        });
        const page = await context.newPage();
        await page.setContent(baseHtml, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.images[0].complete);
        if (scenario !== 'control') {
            await page.evaluate((kind) => {
                const image = document.createElement('img');
                image.id = 'unrelated-image';
                image.width = 80;
                image.height = 80;
                if (kind === 'offscreen_lazy_image') {
                    image.loading = 'lazy';
                    image.style.position = 'absolute';
                    image.style.top = '50000px';
                }
                image.src = 'https://fixture.invalid/pending.png';
                document.body.append(image);
            }, scenario);
        }
        // The actual document is local about:blank. Supply an unchanged verified
        // search scope so the test isolates readiness, not navigation behavior.
        const scopedPage = new Proxy(page, { get(target, prop) {
            if (prop === 'url') return () => searchUrl;
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        const html = await page.content();
        assert.equal(inspectSearchEvidence(html, searchUrl, searchUrl).kind, 'exhausted');
        const available = parseEmbeddedAdRecords(html, 'Nike', ['facebook']);
        assert.equal(available.length, 1);
        assert.ok(available[0].videoUrl && available[0].videoThumbnailUrl);
        const counters = { totalScraped: 0, maxPerQuery: 1, stopped: false,
            spendingLimitReached: false, saveErrorMessage: null };
        const reporter = new RunReporter(['fixture']);
        let saved = 0;
        const router = createRouter(new Set(), counters,
            { platforms: ['facebook'], adStatus: 'active' }, reporter, {
                wait: async () => {}, scroll: async () => false,
                readMedia: async () => new Map(),
                pushData: async () => { saved += 1; return { chargedCount: 1 }; },
            });
        const request = new Request({ url: searchUrl, uniqueKey: 'fixture', label: 'search',
            userData: { keyword: 'Nike', target: { kind: 'keyword', value: 'Nike' } } });
        let reason = null;
        const started = Date.now();
        try { await router({ request, page: scopedPage, log, response: { status: () => 200 } }); }
        catch (error) { reason = error.reason ?? error.name; }
        const elapsedMs = Date.now() - started;
        const images = await page.evaluate(() => Array.from(document.images).map(image => ({
            complete: image.complete, loading: image.loading,
            top: image.getBoundingClientRect().top,
        })));
        assert.equal(reason, null, `${scenario}: an unrelated image must not fail a valid search`);
        assert.equal(saved, 1);
        assert.ok(elapsedMs < 2000, `${scenario}: unrelated images must not consume the five-second preview budget`);
        if (scenario !== 'control') {
            assert.equal(images[1].complete, false);
            if (scenario === 'offscreen_lazy_image') assert.equal(interceptedRequests, 0);
        }
        results.push({ scenario, availableValidAds: available.length, saved, reason,
            elapsedMs, interceptedRequests, images });
        await context.close();
    }
    const fixturePng = Buffer.from(pixel.split(',')[1], 'base64');
    for (const scenario of ['dom_unrelated_lazy_image', 'lazy_video_hydration',
        'ready_and_broken_preview', 'declared_video_dom_recovery',
        'sparse_snapshot_dom_recovery', 'deferred_video_hydration']) {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const requestedImageIds = [];
        await context.route('**/*', async route => {
            const match = route.request().url().match(/^https:\/\/fixture\.invalid\/preview\/(\d+)\.png$/);
            if (!match) { await route.abort(); return; }
            requestedImageIds.push(match[1]);
            if (match[1] === '223456789') { await route.abort(); return; }
            await new Promise(resolve => setTimeout(resolve, 200));
            await route.fulfill({ contentType: 'image/png', body: fixturePng });
        });
        const page = await context.newPage();
        const card = (id, lazy = false) => `<article style="width:360px;min-height:280px;${lazy ? 'position:absolute;top:50000px' : ''}">
            <div>Library ID: ${id}</div><div>Active</div>
            <a href="https://www.facebook.com/profile.php?id=15087023444">Nike</a>
            <div>Sponsored</div><div>Nike running shoes fixture</div>
            <img data-ad-id="${id}" width="300" height="180" ${lazy ? 'loading="lazy"' : ''}
                src="https://fixture.invalid/preview/${id}.png">
            <a href="https://fixture.invalid/item/${id}">Shop Now</a></article>`;
        const delayedSnapshot = ['declared_video_dom_recovery', 'sparse_snapshot_dom_recovery'].includes(scenario)
            ? `<script type="application/json">${JSON.stringify({ ads: [{ ...ad,
                snapshot: { page_name: 'Nike', body: { text: 'Nike fixture running shoes' },
                    ...(scenario === 'declared_video_dom_recovery'
                        ? { display_format: 'VIDEO', images: [{ original_image_url: 'https://fixture.invalid/preview/123456789.png' }] }
                        : {}), },
            }] })}</script>` : '';
        const brokenCard = scenario === 'ready_and_broken_preview' ? card('223456789') : '';
        const unrelated = scenario === 'dom_unrelated_lazy_image'
            ? '<img id="unrelated" loading="lazy" width="80" height="80" style="position:absolute;top:70000px" src="https://fixture.invalid/unrelated.png">' : '';
        const hydration = `<script>
            for (const image of document.querySelectorAll('img[data-ad-id]')) {
                image.addEventListener('load', () => {
                    const hydrate = () => {
                    const video = document.createElement('video');
                    video.preload = 'none'; video.src = 'https://fixture.invalid/video/' + image.dataset.adId + '.mp4';
                    video.poster = image.src; image.after(video);
                    };
                    ${scenario === 'deferred_video_hydration' ? 'setTimeout(hydrate, 50);' : 'hydrate();'}
                }, {once:true});
            }
        </script>`;
        await page.setContent(`<!doctype html><html><body>${card('123456789', scenario === 'lazy_video_hydration')}
            ${brokenCard}${unrelated}${delayedSnapshot}${hydration}</body></html>`, { waitUntil: 'domcontentloaded' });
        const scopedPage = new Proxy(page, { get(target, prop) {
            if (prop === 'url') return () => searchUrl;
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        const rows = [];
        const reporter = new RunReporter(['dom-fixture']);
        const counters = { totalScraped: 0, maxPerQuery: scenario === 'ready_and_broken_preview' ? 3 : 1,
            stopped: false, spendingLimitReached: false, saveErrorMessage: null };
        const router = createRouter(new Set(), counters, { platforms: ['facebook'], adStatus: 'active' }, reporter, {
            wait: async () => {}, scroll: async () => false, readMedia: async () => new Map(),
            pushData: async row => { rows.push(row); return { chargedCount: 1 }; },
        });
        await router({ request: new Request({ url: searchUrl, uniqueKey: 'dom-fixture', label: 'search',
            userData: { keyword: 'Nike', target: { kind: 'keyword', value: 'Nike' } } }),
            page: scopedPage, log, response: { status: () => 200 } });
        assert.equal(rows.length, 1, scenario);
        assert.equal(rows[0].adId, '123456789', scenario);
        assert.equal(rows[0].adType, 'video', scenario);
        assert.equal(rows[0].videoUrl, 'https://fixture.invalid/video/123456789.mp4', scenario);
        assert.equal(rows[0].videoThumbnailUrl, 'https://fixture.invalid/preview/123456789.png', scenario);
        if (scenario === 'ready_and_broken_preview') {
            assert.equal(reporter.job('dom-fixture').reason, 'preview_unready');
            assert.equal(reporter.summary().outcome, 'limited');
        }
        if (scenario === 'dom_unrelated_lazy_image') {
            assert.equal(await page.locator('#unrelated').getAttribute('loading'), 'lazy');
            assert.equal(await page.locator('#unrelated').evaluate(image => image.complete), false);
        }
        results.push({ scenario, saved: rows.length, videoFieldsPreserved: true,
            reason: reporter.job('dom-fixture').reason, requestedImageIds });
        await context.close();
    }
    // Later loaded cards remain reachable after the first bounded DOM batch.
    const largeContext = await browser.newContext({ serviceWorkers: 'block' });
    await largeContext.route('**/*', route => route.abort());
    const largePage = await largeContext.newPage();
    const cards = Array.from({ length: 300 }, (_, i) => `<article style="width:360px;min-height:180px">
        <div>Library ID: ${100000000 + i}</div><div>Active</div>
        <a href="https://www.facebook.com/profile.php?id=15087023444">Nike</a>
        <div>Sponsored</div><div>Nike running shoes ${i}</div>
        <a href="https://fixture.invalid/item/${i}">Shop Now</a></article>`).join('');
    await largePage.setContent(`<!doctype html><html><body>${cards}</body></html>`);
    const scopedLargePage = new Proxy(largePage, { get(target, prop) {
        if (prop === 'url') return () => searchUrl;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const largeReporter = new RunReporter(['large-fixture']);
    const largeCounters = { totalScraped: 0, maxPerQuery: 300, stopped: false,
        spendingLimitReached: false, saveErrorMessage: null };
    const largeSaved = new Set();
    let scrolls = 0;
    const largeRouter = createRouter(new Set(), largeCounters,
        { platforms: ['facebook'], adStatus: 'active' }, largeReporter, {
            wait: async () => {}, scroll: async () => { scrolls += 1; return true; },
            readMedia: async () => new Map(),
            pushData: async record => { largeSaved.add(record.adId); return { chargedCount: 1 }; },
        });
    const largeRequest = new Request({ url: searchUrl, uniqueKey: 'large-fixture', label: 'search',
        userData: { keyword: 'Nike', target: { kind: 'keyword', value: 'Nike' } } });
    await largeRouter({ request: largeRequest, page: scopedLargePage, log, response: { status: () => 200 } });
    assert.equal(await largePage.locator('article').count(), 300);
    assert.equal(largeSaved.size, 300);
    assert.equal(largeReporter.job('large-fixture').reason, 'max_results');
    assert.equal(largeSaved.has('100000299'), true);
    results.push({ scenario: '300_loaded_dom_ads', availableAds: 300,
        saved: largeSaved.size, reason: largeReporter.job('large-fixture').reason,
        outcome: largeReporter.summary().outcome, scrolls,
        lastLoadedAdSaved: largeSaved.has('100000299') });
    await largeContext.close();
    console.log(JSON.stringify({ offlineOnly: true, results }, null, 2));
} finally { await browser.close(); }
