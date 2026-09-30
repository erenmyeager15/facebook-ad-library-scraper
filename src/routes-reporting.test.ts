import assert from 'node:assert/strict';
import test from 'node:test';
import { log, PlaywrightCrawlingContext, Request } from 'crawlee';
import { createRouter, RecoveredAdMedia } from './routes.js';
import { RunReporter, SearchEvidenceError } from './reporting.js';

const url = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active';
const jobIds = ['facebook-search-0', 'facebook-search-1'];
const input = { platforms: ['facebook'], adStatus: 'active' as const };
const jsonScript = (value: unknown): string => `<script type="application/json">${JSON.stringify(value)}</script>`;
const ad = (id: string) => ({
    ad_archive_id: id, page_id: '15087023444', page_name: 'Nike',
    snapshot: { page_name: 'Nike', body: { text: 'Nike running shoes' } },
});
const empty = jsonScript({
    ad_library_main: { search_results_connection: { edges: [], count: 0, page_info: { has_next_page: false } } },
});
const exhausted = jsonScript({
    ad_library_main: {
        search_results_connection: {
            edges: [{ node: { collated_results: [ad('123456789')] } }], count: 1,
            page_info: { has_next_page: false },
        },
    },
});

function harness(options: { max?: number; jobs?: string[]; scroll?: () => Promise<boolean>;
    media?: ReadonlyMap<string, RecoveredAdMedia>;
    onMediaRead?: () => void;
    waitPreviews?: () => Promise<void>;
    push?: (id: string) => Promise<{ chargedCount: number; eventChargeLimitReached?: boolean }> } = {}) {
    let html = '<html>Loading</html>';
    let loadedUrl = url;
    let status = 200;
    let scans = 0;
    let recoveries = 0;
    const reporter = new RunReporter(options.jobs ?? [jobIds[0]]);
    const counters = { totalScraped: 0, maxPerQuery: options.max ?? 2, stopped: false,
        spendingLimitReached: false, saveErrorMessage: null as string | null };
    const seen = new Set<string>();
    const savedIds: string[] = [];
    const page = {
        content: async () => { scans += 1; return html; },
        url: () => loadedUrl,
        goto: async (value: string) => { recoveries += 1; loadedUrl = value; return { status: () => status }; },
        waitForLoadState: async () => {},
        evaluate: async () => [],
        locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as unknown as PlaywrightCrawlingContext['page'];
    const router = createRouter(seen, counters, input, reporter, {
        wait: async () => {},
        scroll: options.scroll ?? (async () => false),
        waitPreviews: options.waitPreviews ?? (async () => {}),
        readMedia: async () => { options.onMediaRead?.(); return options.media ?? new Map(); },
        pushData: async (record) => {
            const result = options.push ? await options.push(record.adId!) : { chargedCount: 1 };
            if (result.chargedCount > 0 || !result.eventChargeLimitReached) savedIds.push(record.adId!);
            return result;
        },
    });
    return {
        reporter, counters, seen, savedIds,
        setHtml(value: string) { html = value; },
        setUrl(value: string) { loadedUrl = value; },
        setStatus(value: number) { status = value; },
        scans: () => scans,
        recoveries: () => recoveries,
        async run(jobId = jobIds[0], retryCount = 0) {
            const request = new Request({ url, uniqueKey: jobId, label: 'search',
                userData: { keyword: 'Nike', target: { kind: 'keyword', value: 'Nike' } } });
            request.retryCount = retryCount;
            await router({ request, page, log, response: { status: () => status } } as unknown as PlaywrightCrawlingContext);
        },
    };
}

test('router confirms empty only from scoped zero and final-page evidence', async () => {
    const h = harness();
    h.setHtml(empty);
    await h.run();
    assert.equal(h.reporter.summary().outcome, 'empty');
    assert.equal(h.reporter.summary().confirmedEmptySearches, 1);
    assert.equal(h.scans(), 3);
    assert.deepEqual(h.savedIds, []);
});

test('recovered media alone cannot create rows or certify a contradictory empty search', async () => {
    const media = new Map([['123456789', { adId: '123456789', imageUrls: [],
        videoUrl: 'https://video.xx.fbcdn.net/public.mp4', videoThumbnailUrl: null }]]);
    const h = harness({ media });
    h.setHtml(empty);
    await assert.rejects(h.run(), SearchEvidenceError);
    assert.deepEqual(h.savedIds, []);
    assert.equal(h.reporter.summary().confirmedEmptySearches, 0);
});

test('loading/no cards throws retryable verification error, never confirmed empty', async () => {
    const h = harness();
    await assert.rejects(h.run(), (error: unknown) => error instanceof SearchEvidenceError && error.reason === 'unverified_zero');
    assert.equal(h.reporter.summary().outcome, 'failed');
    assert.equal(h.reporter.summary().confirmedEmptySearches, 0);
});

test('login redirect cannot save ads even with an embedded matching ad', async () => {
    const h = harness();
    h.setHtml(exhausted);
    h.setUrl('https://www.facebook.com/checkpoint/');
    await assert.rejects(h.run(), (error: unknown) => error instanceof SearchEvidenceError && error.reason === 'blocked');
    assert.deepEqual(h.savedIds, []);
});

test('HTTP access errors reject before page extraction', async () => {
    for (const status of [401, 403, 429, 500]) {
        const h = harness();
        h.setHtml(empty);
        h.setStatus(status);
        await assert.rejects(h.run(), SearchEvidenceError);
        assert.equal(h.scans(), 0);
        assert.equal(h.reporter.summary().confirmedEmptySearches, 0);
    }
});

test('router recovers a reset same-library URL before extracting the requested ad', async () => {
    const h = harness();
    h.setHtml(exhausted);
    h.setUrl('https://www.facebook.com/ads/library/');
    await h.run();
    assert.equal(h.recoveries(), 1);
    assert.deepEqual(h.savedIds, ['123456789']);
    assert.equal(h.reporter.summary().failedSearches, 0);
});

test('recovered document previews finish before the fresh extraction snapshot', async () => {
    let previewChecks = 0;
    const h = harness({ waitPreviews: async () => {
        assert.equal(h.recoveries(), 1);
        previewChecks += 1;
        h.setHtml(exhausted);
    } });
    h.setUrl('https://www.facebook.com/ads/library/');
    await h.run();
    assert.equal(previewChecks, 1);
    assert.deepEqual(h.savedIds, ['123456789']);
});

test('scope reset during preview readiness cannot recover and then save without a new readiness check', async () => {
    const h = harness({ waitPreviews: async () => h.setUrl('https://www.facebook.com/ads/library/') });
    h.setHtml(exhausted);
    await assert.rejects(h.run(), (error: unknown) => error instanceof SearchEvidenceError
        && error.reason === 'search_scope_changed');
    assert.equal(h.recoveries(), 0);
    assert.deepEqual(h.savedIds, []);
});

test('late scope changes during media reads cannot save or charge extracted rows', async () => {
    const h = harness({ onMediaRead: () => h.setUrl(url.replace('q=Nike', 'q=Other')) });
    h.setHtml(exhausted);
    await assert.rejects(h.run(), (error: unknown) => error instanceof SearchEvidenceError
        && error.reason === 'search_scope_changed');
    assert.deepEqual(h.savedIds, []);
    assert.equal(h.seen.size, 0);
    assert.equal(h.counters.totalScraped, 0);
});

test('unready initial previews cannot be saved or charged as image-only ads', async () => {
    const h = harness({ waitPreviews: async () => { throw new SearchEvidenceError('preview_unready'); } });
    h.setHtml(exhausted);
    await assert.rejects(h.run(), (error: unknown) => error instanceof SearchEvidenceError && error.reason === 'preview_unready');
    assert.deepEqual(h.savedIds, []);
    assert.equal(h.seen.size, 0);
});

test('retry recovery stays one job with no terminal failure', async () => {
    const h = harness();
    await assert.rejects(h.run(), SearchEvidenceError);
    h.setHtml(exhausted);
    await h.run(jobIds[0], 1);
    const summary = h.reporter.summary();
    assert.equal(summary.outcome, 'results');
    assert.equal(summary.plannedSearches, 1);
    assert.equal(summary.failedSearches, 0);
    assert.equal(summary.retries, 1);
    assert.equal(summary.savedAds, 1);
});

test('partial save then retry respects per-job cap and does not reserve unsaved ads', async () => {
    let throws = true;
    const h = harness({ jobs: jobIds, max: 2, scroll: async () => {
        if (throws) throw new Error('Fixture navigation interruption');
        return false;
    } });
    h.setHtml(jsonScript({ ads: [ad('123456789')] }));
    await assert.rejects(h.run(), /Fixture navigation interruption/);
    assert.equal(h.reporter.job(jobIds[0]).savedAds, 1);
    throws = false;
    h.setHtml(jsonScript({ ads: [ad('123456789'), ad('223456789'), ad('323456789')] }));
    await h.run(jobIds[0], 1);
    assert.equal(h.savedIds.length, 2);
    assert.equal(h.savedIds[0], '123456789');
    const unsavedId = h.savedIds.includes('223456789') ? '323456789' : '223456789';
    assert.equal(h.reporter.job(jobIds[0]).savedAds, 2);
    assert.equal(h.reporter.job(jobIds[0]).reason, 'max_results');
    assert.equal(h.seen.has(unsavedId), false);
    // A distinct target sharing the URL can still collect the unsaved third ad.
    await h.run(jobIds[1]);
    assert.deepEqual(new Set(h.savedIds), new Set(['123456789', '223456789', '323456789']));
    assert.equal(h.reporter.summary().plannedSearches, 2);
});

test('zero budget yields limited coverage, not source-empty or failure', async () => {
    const h = harness({ jobs: jobIds, push: async () => ({ chargedCount: 0, eventChargeLimitReached: true }) });
    h.setHtml(exhausted);
    await h.run();
    await h.run(jobIds[1]);
    const summary = h.reporter.summary({ spendingLimitReached: h.counters.spendingLimitReached });
    assert.equal(summary.outcome, 'limited');
    assert.equal(summary.savedAds, 0);
    assert.equal(summary.confirmedEmptySearches, 0);
    assert.equal(summary.limitedSearches, 2);
    assert.equal(h.seen.size, 0);
});

test('save failure stops work without retaining the raw provider error', async () => {
    const h = harness({ push: async () => { throw new Error('secret-cookie-private-url'); } });
    h.setHtml(exhausted);
    await h.run();
    assert.equal(h.counters.stopped, true);
    assert.equal(h.reporter.summary({ fatalReason: 'save_error' }).outcome, 'failed');
    assert.equal(h.reporter.job(jobIds[0]).reason, 'save_error');
    assert.equal(h.seen.size, 0);
    assert.equal(h.counters.saveErrorMessage?.includes('secret-cookie'), false);
});

test('duplicate-only second job is no-new-data, never confirmed empty', async () => {
    const h = harness({ jobs: jobIds });
    h.setHtml(exhausted);
    await h.run();
    await h.run(jobIds[1]);
    assert.equal(h.reporter.job(jobIds[1]).outcome, 'limited');
    assert.equal(h.reporter.job(jobIds[1]).reason, 'no_new_data');
    assert.equal(h.reporter.summary().outcome, 'limited');
    assert.equal(h.reporter.summary().confirmedEmptySearches, 0);
    assert.equal(h.savedIds.length, 1);
});

test('unrelated generic ads cannot turn an unverified search into success', async () => {
    const h = harness();
    h.setHtml(jsonScript({ ads: [{ ...ad('123456789'), page_name: 'Other',
        snapshot: { page_name: 'Other', body: { text: 'Other creative' } } }] }));
    await assert.rejects(h.run(), SearchEvidenceError);
    assert.equal(h.reporter.summary().outcome, 'failed');
    assert.deepEqual(h.savedIds, []);
    assert.equal(h.reporter.summary().confirmedEmptySearches, 0);
});

test('stale scrolling after ads is limited, not exhaustive results', async () => {
    const h = harness();
    h.setHtml(jsonScript({ ads: [ad('123456789')] }));
    await h.run();
    assert.equal(h.reporter.summary().outcome, 'limited');
    assert.equal(h.reporter.job(jobIds[0]).reason, 'stale_scroll');
    assert.equal(h.reporter.summary().exhaustiveArchive, false);
});

test('a contradictory zero payload cannot erase saved or visible ads', async () => {
    const h = harness();
    h.setHtml(empty + jsonScript({ ads: [ad('123456789')] }));
    await h.run();
    assert.equal(h.reporter.summary().outcome, 'limited');
    assert.equal(h.reporter.summary().confirmedEmptySearches, 0);
    assert.equal(h.reporter.summary().savedAds, 1);
});

test('concurrent jobs reserve one ad once while its atomic save is pending', async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const saving = new Promise<void>((resolve) => { started = resolve; });
    let pushes = 0;
    const h = harness({ jobs: jobIds, push: async () => {
        pushes += 1;
        started();
        await pending;
        return { chargedCount: 1 };
    } });
    h.setHtml(exhausted);
    const first = h.run(jobIds[0]);
    await saving;
    await h.run(jobIds[1]);
    release();
    await first;
    assert.equal(pushes, 1);
    assert.equal(h.reporter.summary().savedAds, 1);
    assert.equal(h.counters.totalScraped, 1);
    assert.equal(h.reporter.job(jobIds[1]).reason, 'no_new_data');
});

test('saved rows followed by a terminal blocked search remain partial', async () => {
    const h = harness({ jobs: jobIds });
    h.setHtml(exhausted);
    await h.run(jobIds[0]);
    h.setUrl('https://www.facebook.com/login/');
    await assert.rejects(h.run(jobIds[1], 3), SearchEvidenceError);
    h.reporter.finish(jobIds[1], 'failed', 'blocked', 3);
    const summary = h.reporter.summary();
    assert.equal(summary.outcome, 'partial');
    assert.equal(summary.savedAds, 1);
    assert.equal(summary.failedSearches, 1);
    assert.equal(summary.confirmedEmptySearches, 0);
});

test('a concurrent duplicate cannot mask a pending save that later fails', async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const saving = new Promise<void>((resolve) => { started = resolve; });
    const h = harness({ jobs: jobIds, push: async () => {
        started();
        await pending;
        throw new Error('private-provider-error');
    } });
    h.setHtml(exhausted);
    const first = h.run(jobIds[0]);
    await saving;
    await h.run(jobIds[1]);
    release();
    await first;
    const summary = h.reporter.summary({ fatalReason: 'save_error' });
    assert.equal(summary.outcome, 'failed');
    assert.equal(summary.savedAds, 0);
    assert.equal(summary.confirmedEmptySearches, 0);
    assert.equal(h.seen.size, 0);
    assert.equal(JSON.stringify(summary).includes('private-provider-error'), false);
});
