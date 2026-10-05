// Local browser fixtures only. All public requests are intercepted; no Apify
// build, run, charge, dataset write or production setting is involved.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { log, LogLevel, Request } from 'crawlee';
import { createRouter } from '../dist/routes.js';
import { RunReporter, SearchEvidenceError } from '../dist/reporting.js';

log.setLevel(LogLevel.ERROR);
const searchUrl = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function card(id, advertiser = 'Nike', { lazyVideo = false, broken = false } = {}) {
    const preview = lazyVideo || broken
        ? `<img loading="lazy" width="80" height="80" src="https://fixture.invalid/${broken ? 'broken' : 'preview'}/${id}.png" ${lazyVideo ? `onload="const v=document.createElement('video');v.src='https://fixture.invalid/video/${id}.mp4';v.poster=this.src;this.parentElement.append(v)"` : ''}>`
        : '';
    return `<article style="width:360px;min-height:180px">
        <div>Library ID: ${id}</div><div>Active</div>
        <a href="https://www.facebook.com/profile.php?id=15087023444">${advertiser}</a>
        <div>Sponsored</div><div>${advertiser} running shoes fixture ${id}</div>
        ${preview}<a href="https://fixture.invalid/item/${id}">Shop Now</a></article>`;
}

function payload(records) {
    return `<script type="application/json">${JSON.stringify({ ad_library_main: {
        search_results_connection: {
            edges: records.map(record => ({ node: { collated_results: [record] } })),
            count: records.length, page_info: { has_next_page: false },
        },
    } })}</script>`;
}

const browser = await chromium.launch({ headless: true });
const results = [];

async function fixture(name, html, max, options = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let publicRequestsIntercepted = 0;
    await context.route('**/*', async route => {
        publicRequestsIntercepted += 1;
        const url = route.request().url();
        if (url.startsWith('https://fixture.invalid/preview/')) {
            // The selected lazy preview must load before the card inserts its
            // video. A later readiness batch activates later cards individually.
            await new Promise(resolve => setTimeout(resolve, 35));
            await route.fulfill({ status: 200, contentType: 'image/png', body: pixel });
        } else if (url.startsWith('https://fixture.invalid/broken/')) {
            await route.fulfill({ status: 404, body: '' });
        } else {
            await route.abort();
        }
    });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`, { waitUntil: 'domcontentloaded' });
    const batches = [];
    const scopedPage = new Proxy(page, { get(target, prop) {
        if (prop === 'url') return () => searchUrl;
        if (prop === 'evaluate') return async (fn, argument) => {
            const value = await target.evaluate(fn, argument);
            if (value && Array.isArray(value.candidates) && Array.isArray(value.candidateAdIds)) {
                batches.push({ preview: Boolean(argument?.inspectPreviewsOnly),
                    count: value.candidates.length, checked: value.candidateAdIds.length,
                    more: value.hasMoreCandidates, pending: value.pendingAdIds.length });
            }
            return value;
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const saved = new Map();
    const chargeCounts = new Map();
    const seenIds = new Set(options.alreadySaved ?? []);
    const counters = { totalScraped: 0, maxPerQuery: max, stopped: false,
        spendingLimitReached: false, saveErrorMessage: null };
    const reporter = new RunReporter(['fixture']);
    let scrolls = 0;
    let reads = 0;
    let retryTriggered = false;
    const dependencies = {
        wait: async () => {},
        scroll: async () => { scrolls += 1; return false; },
        readMedia: async () => new Map(),
        pushData: async record => {
            saved.set(record.adId, record);
            chargeCounts.set(record.adId, (chargeCounts.get(record.adId) ?? 0) + 1);
            return { chargedCount: 1 };
        },
        ...(options.retryAfterFirstBatch ? { readSearch: async () => {
            reads += 1;
            if (reads === 2 && !retryTriggered) {
                retryTriggered = true;
                throw new SearchEvidenceError('navigation_interrupted');
            }
            return { html: await page.content(), url: searchUrl };
        } } : {}),
    };
    const router = createRouter(seenIds, counters,
        { platforms: ['facebook'], adStatus: 'active' }, reporter, dependencies);
    const makeRequest = retryCount => new Request({ url: searchUrl, uniqueKey: 'fixture', label: 'search',
        retryCount, userData: { keyword: 'Nike', target: { kind: 'keyword', value: 'Nike' } } });
    const run = request => router({ request, page: scopedPage, log, response: { status: () => 200 } });
    try {
        if (options.retryAfterFirstBatch) {
            await assert.rejects(run(makeRequest(0)), error => error.reason === 'navigation_interrupted');
            assert.equal(saved.size, 25);
            await run(makeRequest(1));
        } else {
            await run(makeRequest(0));
        }
        assert.ok(batches.filter(batch => batch.preview).every(batch => batch.checked <= 25));
        assert.ok(batches.filter(batch => !batch.preview).every(batch => batch.count <= 250));
        assert.ok([...chargeCounts.values()].every(count => count === 1));
        await options.check?.({ saved, counters, reporter, batches, page, scrolls });
        results.push({ scenario: name, saved: saved.size, reason: reporter.job('fixture').reason,
            retries: reporter.job('fixture').retries, scrolls, publicRequestsIntercepted,
            previewBatchMaximum: Math.max(0, ...batches.filter(batch => batch.preview).map(batch => batch.checked)),
            outputBatchMaximum: Math.max(0, ...batches.filter(batch => !batch.preview).map(batch => batch.count)) });
    } finally {
        await context.close();
    }
}

try {
    await fixture('300_loaded_matching_cards', Array.from({ length: 300 }, (_, i) => card(100000000 + i)).join(''), 300, {
        check: ({ saved, scrolls }) => { assert.equal(saved.size, 300); assert.ok(saved.has('100000299')); assert.equal(scrolls, 0); },
    });

    await fixture('800_rejected_then_30_matching', [
        ...Array.from({ length: 800 }, (_, i) => card(200000000 + i, 'Adidas')),
        ...Array.from({ length: 30 }, (_, i) => card(300000000 + i)),
    ].join(''), 30, {
        check: ({ saved, scrolls }) => { assert.equal(saved.size, 30); assert.ok(saved.has('300000029')); assert.equal(scrolls, 0); },
    });

    await fixture('300_saved_duplicates_then_20_new', [
        ...Array.from({ length: 300 }, (_, i) => card(400000000 + i)),
        ...Array.from({ length: 20 }, (_, i) => card(500000000 + i)),
    ].join(''), 20, {
        alreadySaved: Array.from({ length: 300 }, (_, i) => String(400000000 + i)),
        check: ({ saved, scrolls }) => {
            assert.equal(saved.size, 20);
            assert.ok([...saved.keys()].every(id => Number(id) >= 500000000));
            assert.equal(scrolls, 0);
        },
    });

    await fixture('retry_after_25_saved', Array.from({ length: 300 }, (_, i) => card(600000000 + i)).join(''), 300, {
        retryAfterFirstBatch: true,
        check: ({ saved, reporter, counters }) => {
            assert.equal(saved.size, 300); assert.equal(counters.totalScraped, 300);
            assert.equal(reporter.job('fixture').savedAds, 300); assert.equal(reporter.job('fixture').retries, 1);
        },
    });

    await fixture('250_rejected_then_30_lazy_videos', [
        ...Array.from({ length: 250 }, (_, i) => card(700000000 + i, 'Adidas')),
        ...Array.from({ length: 30 }, (_, i) => card(800000000 + i, 'Nike', { lazyVideo: true })),
    ].join(''), 30, {
        check: ({ saved, scrolls }) => {
            assert.equal(saved.size, 30); assert.equal(scrolls, 0);
            for (const [id, record] of saved) {
                assert.equal(record.adType, 'video');
                assert.equal(record.videoUrl, `https://fixture.invalid/video/${id}.mp4`);
                assert.equal(record.videoThumbnailUrl, `https://fixture.invalid/preview/${id}.png`);
            }
        },
    });

    const embeddedVideos = Array.from({ length: 30 }, (_, i) => ({
        ad_archive_id: String(900000000 + i), page_id: '15087023444', page_name: 'Nike',
        start_date: 1735689600, publisher_platform: ['FACEBOOK'], snapshot: {
            page_name: 'Nike', display_format: 'VIDEO', body: { text: `Nike structured body ${i}` },
            title: `Structured headline ${i}`, link_description: `Structured description ${i}`,
            link_url: `https://fixture.invalid/structured-target/${i}`,
            images: [{ original_image_url: `https://fixture.invalid/preview/${900000000 + i}.png` }],
        },
    }));
    await fixture('declared_embedded_videos_merge_hydrated_dom', payload(embeddedVideos)
        + embeddedVideos.map(record => card(record.ad_archive_id, 'Nike', { lazyVideo: true })).join(''), 30, {
        check: ({ saved }) => {
            assert.equal(saved.size, 30);
            for (let i = 0; i < 30; i += 1) {
                const record = saved.get(String(900000000 + i));
                assert.equal(record.adType, 'video');
                assert.equal(record.videoUrl, `https://fixture.invalid/video/${900000000 + i}.mp4`);
                assert.equal(record.adHeadline, `Structured headline ${i}`);
                assert.equal(record.adDescription, `Structured description ${i}`);
                assert.equal(record.destinationUrl, `https://fixture.invalid/structured-target/${i}`);
                assert.equal(record.adCreativeText, `Nike structured body ${i}`);
                assert.equal(record.adStartDate, '2025-01-01T00:00:00.000Z');
            }
        },
    });

    const partialSnapshots = embeddedVideos.map((record, index) => ({
        ...record, ad_archive_id: String(905000000 + index),
        snapshot: {
            page_name: 'Nike', body: { text: `Nike partial snapshot body ${index}` },
            title: `Partial snapshot headline ${index}`,
            link_description: `Partial snapshot description ${index}`,
            link_url: `https://fixture.invalid/partial-target/${index}`,
        },
    }));
    await fixture('partial_snapshot_does_not_mask_later_dom_video', payload(partialSnapshots)
        + partialSnapshots.map(record => card(record.ad_archive_id, 'Nike', { lazyVideo: true })).join(''), 30, {
        check: ({ saved }) => {
            assert.equal(saved.size, 30);
            for (let i = 0; i < 30; i += 1) {
                const record = saved.get(String(905000000 + i));
                assert.equal(record.adType, 'video');
                assert.equal(record.videoUrl, `https://fixture.invalid/video/${905000000 + i}.mp4`);
                assert.equal(record.adHeadline, `Partial snapshot headline ${i}`);
                assert.equal(record.adDescription, `Partial snapshot description ${i}`);
                assert.equal(record.destinationUrl, `https://fixture.invalid/partial-target/${i}`);
                assert.equal(record.adCreativeText, `Nike partial snapshot body ${i}`);
            }
        },
    });

    const missingVideo = { ...embeddedVideos[0], ad_archive_id: '910000000' };
    const completeSibling = { ...embeddedVideos[1], ad_archive_id: '910000001',
        snapshot: { ...embeddedVideos[1].snapshot, display_format: 'IMAGE' } };
    await fixture('missing_declared_video_deferred_ready_sibling_saved',
        payload([missingVideo, completeSibling]) + card('910000000') + card('910000001'), 2, {
            check: ({ saved, reporter }) => {
                assert.equal(saved.size, 1); assert.ok(saved.has('910000001'));
                assert.equal(reporter.job('fixture').reason, 'preview_unready');
            },
        });

    await fixture('broken_first_preview_does_not_starve_later_cards', card(920000000, 'Nike', { broken: true })
        + Array.from({ length: 55 }, (_, i) => card(930000000 + i)).join(''), 100, {
            check: ({ saved, reporter }) => {
                assert.equal(saved.size, 55); assert.equal(saved.has('920000000'), false);
                assert.equal(reporter.job('fixture').reason, 'preview_unready');
            },
        });
    console.log(JSON.stringify({ offlineOnly: true, publicRequestsSent: 0, results }, null, 2));
} finally {
    await browser.close();
}
