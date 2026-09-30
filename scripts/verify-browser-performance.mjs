// Offline Chromium integration check. A local HTTP proxy serves every fixture
// resource; unknown destinations and CONNECT requests are rejected. No Apify
// run, residential proxy, customer input, or real Facebook request is involved.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { log, LogLevel, playwrightUtils, Request } from 'crawlee';
import { blockMediaDownloads, waitForAdPreviews } from '../dist/performance.js';
import { createRouter } from '../dist/routes.js';
import { RunReporter } from '../dist/reporting.js';

log.setLevel(LogLevel.ERROR);
const png = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
    Buffer.alloc(128 * 1024),
]);
const font = Buffer.alloc(64 * 1024);
const video = Buffer.alloc(128 * 1024);
const imageUrl = (id) => `http://scontent.fixture.fbcdn.net/${id}.jpg`;
const videoUrl = (id) => `http://video.fixture.fbcdn.net/${id}.mp4`;
const cards = Array.from({ length: 25 }, (_, index) => {
    const id = String(100000000 + index);
    const type = index % 5;
    const media = type === 0 ? `<img width="300" height="180" src="${imageUrl(id)}">`
        : type === 1 ? `<img class="video-preview" data-ad-id="${id}" width="300" height="180" src="${imageUrl(id)}">`
            : type === 2 ? `<img width="300" height="180" src="${imageUrl(id)}"><img width="300" height="180" src="${imageUrl(id + '-2')}">`
                : type === 3 ? '<div>Text-only creative</div>'
                    : `<div class="background" style="background-image:url('${imageUrl(id)}')"></div>`;
    return `<article><div>Library ID: ${id}</div><div>Active</div>
        <a href="https://www.facebook.com/profile.php?id=15087023444">Nike</a>
        <div>Sponsored</div><div>Nike fixture creative ${index}</div>${media}
        <div>nike.example</div><div>Nike fixture headline ${index}</div>
        <a href="https://nike.example/${id}">Shop Now</a></article>`;
}).join('');
const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="http://static.fixture.fbcdn.net/style.css">
    <script defer src="http://static.fixture.fbcdn.net/app.js"></script>
    </head><body>${cards}<img width="16" height="16" src="http://static.fixture.fbcdn.net/control.svg"></body></html>`;
const css = `@font-face{font-family:Fixture;src:url('http://static.fixture.fbcdn.net/font.woff2')}
    body{font-family:Fixture,Arial}article{width:360px;min-height:280px;margin:16px;padding:12px}
    .background{width:300px;height:180px;background-size:cover}`;
const publicPayload = { ads: Array.from({ length: 25 }, (_, index) => {
    const id = String(100000000 + index);
    return { ad_archive_id: id, snapshot: { page_name: 'Nike',
        images: index % 5 === 3 ? [] : [{ original_image_url: imageUrl(id) }],
        videos: index % 5 === 1 ? [{ video_sd_url: videoUrl(id), video_preview_image_url: imageUrl(id) }] : [],
    } };
}) };
const js = `for (const img of document.querySelectorAll('.video-preview')) {
    const hydrate = () => {
        if (img.dataset.hydrated) return; img.dataset.hydrated = 'yes';
        const video = document.createElement('video'); video.width = 300; video.height = 180;
        video.preload = 'auto'; video.src = 'http://video.fixture.fbcdn.net/' + img.dataset.adId + '.mp4';
        video.poster = img.src; img.after(video);
    };
    if (img.complete && img.naturalWidth) hydrate(); else img.addEventListener('load', hydrate, {once:true});
}
fetch('/fixture-data?creative_url=' + encodeURIComponent('http://scontent.fixture.fbcdn.net/ad.png'))
    .then(r=>r.json()).then(data=>{window.fixtureMedia=JSON.stringify(data.payload);window.fixtureReady=data.ok;});`;
let active;
const phases = {};
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
    const fixture = ['scontent.fixture.fbcdn.net', 'video.fixture.fbcdn.net', 'static.fixture.fbcdn.net'].includes(url.hostname);
    if (!local && !fixture) { res.writeHead(403); res.end(); return; }
    let body;
    let kind;
    let contentType;
    if (url.pathname.endsWith('.jpg')) { body = png; kind = 'media'; contentType = 'image/png'; }
    else if (url.pathname.endsWith('.mp4')) { body = video; kind = 'media'; contentType = 'video/mp4'; }
    else if (url.pathname.endsWith('.woff2')) { body = font; kind = 'font'; contentType = 'font/woff2'; }
    else if (url.pathname === '/style.css') { body = Buffer.from(css); kind = 'css'; contentType = 'text/css'; }
    else if (url.pathname === '/app.js') { body = Buffer.from(js); kind = 'script'; contentType = 'text/javascript'; }
    else if (url.pathname === '/control.svg') {
        body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>');
        kind = 'icon'; contentType = 'image/svg+xml';
    } else if (url.pathname === '/fixture-data') { body = Buffer.from(JSON.stringify({ ok: true, payload: publicPayload })); kind = 'data'; contentType = 'application/json'; }
    else if (url.pathname.startsWith('/ads/library/')) { body = Buffer.from(html); kind = 'document'; contentType = 'text/html'; }
    else { res.writeHead(404); res.end(); return; }
    if (active) {
        active.bytes += body.length;
        active.counts[kind] = (active.counts[kind] ?? 0) + 1;
        if (url.pathname.endsWith('.mp4')) active.videoDownloads = (active.videoDownloads ?? 0) + 1;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length,
        'Cache-Control': ['script', 'css', 'icon', 'media', 'font'].includes(kind)
            ? 'public, max-age=3600, immutable' : 'no-store' });
    // Deliberately slow preview images. DOMContentLoaded/data readiness alone
    // must not let the first batch be saved before video hydration occurs.
    if (url.pathname.endsWith('.jpg')) setTimeout(() => res.end(body), 750);
    else res.end(body);
});
server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await chromium.launch({ headless: true, proxy: { server: origin },
        args: ['--disable-background-networking', '--disable-features=HttpsUpgrades'] });
    for (const phase of ['baseline', 'aggressive-control', 'optimized']) {
        const context = await browser.newContext();
        const page = await context.newPage();
        active = phases[phase] = { bytes: 0, counts: {} };
        if (phase === 'optimized') {
            await blockMediaDownloads((options) => playwrightUtils.blockRequests(page, options));
        } else if (phase === 'aggressive-control') {
            // Preserve the rejected policy as a negative control. Without initial
            // matching data, blocking previews suppresses video DOM hydration.
            await playwrightUtils.blockRequests(page, { urlPatterns: [
                '*://scontent*.fbcdn.net/*', '*://video*.fbcdn.net/*', '*://external*.fbcdn.net/*',
                '*://*.fbcdn.net/*.woff*', '*://*.fbcdn.net/*.ttf*', '*://*.fbcdn.net/*.otf*',
            ] });
        }
        // Two navigations exercise both early blocking and unchanged HTTP cache.
        for (const path of ['warm-up', 'search']) {
            await page.goto(`${origin}/ads/library/${path}?q=Nike`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForFunction(() => window.fixtureReady === true, { timeout: 10000 });
            const pendingPreviews = await page.evaluate(() => Array.from(document.images).filter((image) => !image.complete).length);
            if (pendingPreviews) phases[phase].observedPendingPreviews = true;
            await waitForAdPreviews(page);
        }
        const requestedUrl = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active';
        // Extraction fixture only: the real source-scope checks are covered by
        // reporting tests. The browser remains entirely on the local server.
        const extractionPage = new Proxy(page, { get(target, key) {
            if (key === 'url') return () => requestedUrl;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        const rows = [];
        const reporter = new RunReporter(['fixture']);
        const counters = { totalScraped: 0, maxPerQuery: 25, stopped: false,
            spendingLimitReached: false, saveErrorMessage: null };
        const router = createRouter(new Set(), counters, { platforms: ['facebook'], adStatus: 'active' }, reporter, {
            wait: async () => {}, scroll: async () => false,
            // Reproduce the live first-batch gap: there is no matching media
            // payload available to enrich these records before they are saved.
            // Quality must hold through the DOM fallback, not a perfect fixture
            // payload that concealed the initial regression in earlier checks.
            readMedia: async () => new Map(),
            pushData: async (record) => { rows.push(record); return { chargedCount: 1 }; },
        });
        await router({ page: extractionPage, log, response: { status: () => 200 },
            request: new Request({ url: requestedUrl, label: 'search', uniqueKey: 'fixture',
                userData: { keyword: 'Nike', target: { kind: 'keyword', value: 'Nike' } } }) });
        assert.equal(rows.length, 25);
        assert.equal(new Set(rows.map((row) => row.adId)).size, 25);
        const videoRecords = rows.filter((row) => row.videoUrl && row.videoThumbnailUrl).length;
        assert.equal(videoRecords, phase === 'aggressive-control' ? 0 : 5);
        phases[phase].videoRecords = videoRecords;
        assert.equal(reporter.summary().jobs[0].reason, 'max_results');
        phases[phase].rows = rows.map(({ scrapedAt, ...row }) => row);
        assert.equal(active.counts.script, 1, `${phase}: warm-up must not disable the script cache`);
        assert.equal(active.counts.css, 1, `${phase}: CSS must remain cached and available`);
        assert.equal(active.counts.data, 2, `${phase}: both data requests must complete`);
        assert.equal(active.counts.icon, 1, `${phase}: the control icon must remain available`);
        await context.close();
    }
    assert.ok(phases.baseline.counts.media > 0);
    assert.ok(phases.baseline.counts.font > 0);
    assert.ok(phases.optimized.counts.media > 0, 'preview images must load to preserve initial video hydration');
    assert.equal(phases['aggressive-control'].counts.media ?? 0, 0);
    assert.equal(phases.optimized.counts.font ?? 0, 0);
    assert.ok(phases.baseline.videoDownloads > 0);
    assert.equal(phases.optimized.videoDownloads ?? 0, 0);
    assert.equal(phases.optimized.observedPendingPreviews, true, 'test must exercise delayed initial previews');
    assert.deepEqual(phases.optimized.rows, phases.baseline.rows);
    assert.ok(phases.optimized.bytes < phases.baseline.bytes);
    console.log(JSON.stringify({ fixtureOnly: true, externalAccessRejected: true,
        baseline: { bytes: phases.baseline.bytes, requests: phases.baseline.counts },
        optimized: { bytes: phases.optimized.bytes, requests: phases.optimized.counts },
        noInitialMediaMetadata: true,
        aggressiveControlVideoRecords: phases['aggressive-control'].videoRecords,
        optimizedVideoRecords: phases.optimized.videoRecords,
        delayedInitialPreviewsWaitedFor: true, optimizedVideoDownloads: phases.optimized.videoDownloads ?? 0,
        same25RowsIncludingMediaUrls: true, scriptAndStyleCachePreserved: true,
        actualApifySavingsMeasured: false }));
} finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
}
