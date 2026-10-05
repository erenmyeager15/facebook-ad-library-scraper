// Entirely intercepted browser fixture: no Facebook, proxy or Apify requests.
// Reproduces a player being removed when its binary download is blocked.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { log, LogLevel, playwrightUtils, Request } from 'crawlee';
import { blockMediaDownloads } from '../dist/performance.js';
import { installDomAdMediaCapture, readCapturedDomAdMedia } from '../dist/dom-media.js';
import { createRouter } from '../dist/routes.js';
import { RunReporter } from '../dist/reporting.js';

log.setLevel(LogLevel.ERROR);
const searchUrl = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active';
const imageUrl = 'https://scontent.fixture.fbcdn.net/creative.jpg';
const videoUrl = 'https://video.fixture.fbcdn.net/creative.mp4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const card = `<article style="width:360px;min-height:280px"><div>Library ID: 123456789</div>
<div>Active</div><a href="https://www.facebook.com/profile.php?id=15087023444">Nike</a>
<div>Sponsored</div><div>Nike fixture running shoes</div><div id="player"></div>
<div>nike.example</div><div>Nike fixture headline</div><a href="https://nike.example/product">Shop Now</a></article>`;
const html = `<!doctype html><html><body>${card}<script>
const video = document.createElement('video'); video.width=300; video.height=180;
video.poster=${JSON.stringify(imageUrl)}; video.preload='auto';
video.addEventListener('error',()=>{const image=document.createElement('img');
 image.width=300;image.height=180;image.src=video.poster;video.replaceWith(image);window.playerRemoved=true;});
video.src=${JSON.stringify(videoUrl)};document.querySelector('#player').append(video);
</script></body></html>`;
const browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
const results = [];
try {
    for (const capture of [false, true]) {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        let videoDownloads = 0;
        await context.route('**/*', async route => {
            const url = route.request().url();
            if (url === searchUrl) return route.fulfill({ contentType: 'text/html', body: html });
            if (url === imageUrl) return route.fulfill({ contentType: 'image/png', body: png });
            if (url === videoUrl) videoDownloads += 1;
            return route.abort();
        });
        const page = await context.newPage();
        await blockMediaDownloads(options => playwrightUtils.blockRequests(page, options));
        if (capture) await installDomAdMediaCapture(page);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.playerRemoved === true);
        assert.equal(await page.locator('video').count(), 0);
        const media = await readCapturedDomAdMedia(page, searchUrl);
        assert.equal(media.size, capture ? 1 : 0);
        if (capture) {
            assert.equal(media.get('123456789').videoUrl, videoUrl);
            assert.equal(media.get('123456789').videoThumbnailUrl, imageUrl);
        }
        const rows = [];
        const counters = { totalScraped: 0, maxPerQuery: 1, stopped: false,
            spendingLimitReached: false, saveErrorMessage: null };
        const reporter = new RunReporter(['fixture']);
        const router = createRouter(new Set(), counters, { platforms: ['facebook'], adStatus: 'active' }, reporter, {
            wait: async () => {}, scroll: async () => false,
            readMedia: current => readCapturedDomAdMedia(current, searchUrl),
            pushData: async row => { rows.push(row); return { chargedCount: 1 }; },
        });
        await router({ page, log, response: { status: () => 200 },
            request: new Request({ url: searchUrl, uniqueKey: 'fixture', label: 'search',
                userData: { keyword: 'Nike', target: { kind: 'keyword', value: 'Nike' } } }) });
        assert.equal(rows.length, 1);
        assert.equal(Boolean(rows[0].videoUrl && rows[0].videoThumbnailUrl), capture);
        assert.equal(videoDownloads, 0, 'no binary reached the fixture handler');
        results.push({ scenario: capture ? 'repair' : 'negative_control', rows: rows.length,
            videoRecords: rows.filter(row => row.videoUrl && row.videoThumbnailUrl).length, videoDownloads });
        if (capture) {
            // Same-document query changes must not reuse the old ad's media.
            await page.evaluate(() => history.pushState({}, '', '?q=Adidas&country=US&active_status=active'));
            assert.equal((await readCapturedDomAdMedia(page, searchUrl)).size, 0);
            await page.evaluate(() => document.body.append(document.createElement('div')));
            assert.equal((await readCapturedDomAdMedia(page, page.url())).size, 0);
            results.push({ scenario: 'query_change_discards_old_media', passed: true });
        }
        await context.close();
    }
    // Independent fixture verifies source children, ambiguity and URL bounds.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url() === searchUrl
        ? route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }) : route.abort());
    const page = await context.newPage();
    await installDomAdMediaCapture(page);
    await page.goto(searchUrl);
    await page.evaluate(({ imageUrl, videoUrl }) => {
        const add = (id, source, poster, otherId = '') => {
            const article = document.createElement('article');
            article.textContent = `Library ID: ${id} ${otherId && 'Library ID: ' + otherId}`;
            const video = document.createElement('video'); video.preload = 'none';
            const child = document.createElement('source'); child.src = source;
            video.append(child); if (poster) video.poster = poster;
            article.append(video); document.body.append(article);
        };
        add('234567891', videoUrl, imageUrl);
        add('345678912', videoUrl, imageUrl, '456789123');
        add('567891234', 'blob:https://www.facebook.com/12345', 'data:image/png;base64,AAAA');
        add('678912345', 'https://fixture.invalid/' + 'a'.repeat(9000), '');
    }, { imageUrl, videoUrl });
    await page.waitForTimeout(50);
    let media = await readCapturedDomAdMedia(page, searchUrl);
    assert.deepEqual([...media.keys()], ['234567891']);
    assert.equal(media.get('234567891').videoUrl, videoUrl);
    results.push({ scenario: 'source_child_unsafe_urls_and_ambiguous_ids', passed: true });
    // Make 510 separately delivered batches, matching paginated long searches.
    for (let batch = 0; batch < 6; batch += 1) {
        await page.evaluate(({ batch, videoUrl, imageUrl }) => {
            if (batch === 0) document.body.replaceChildren();
            for (let offset = 0; offset < 85; offset += 1) {
                const article = document.createElement('article');
                article.textContent = 'Library ID: ' + (800000000 + batch * 85 + offset);
                const video = document.createElement('video'); video.preload = 'none';
                video.src = videoUrl; video.poster = imageUrl;
                article.append(video); document.body.append(article);
            }
        }, { batch, videoUrl, imageUrl });
    }
    media = await readCapturedDomAdMedia(page, searchUrl);
    assert.equal(media.size, 500);
    assert.equal(media.has('800000000'), false);
    assert.equal(media.has('800000509'), true);
    results.push({ scenario: 'bounded_cache_admits_later_pages', retained: media.size });
    await context.close();
    console.log(JSON.stringify({ fixtureOnly: true, allRequestsIntercepted: true, results }));
} finally { await browser.close(); }
