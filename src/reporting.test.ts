import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSearchEvidence, RunReporter, SearchEvidenceError } from './reporting.js';

const requestedUrl = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active&ad_type=all&search_type=keyword_unordered&media_type=all&publisher_platforms%5B0%5D=facebook';
const script = (value: unknown): string => `<script type="application/json">${JSON.stringify(value)}</script>`;
const emptyConnection = () => ({ edges: [], count: 0, page_info: { has_next_page: false } });
const mainPayload = (connection: unknown = emptyConnection()) => ({
    data: { ad_library_main: { search_results_connection: connection } },
});
const inspect = (payload: unknown, loadedUrl = requestedUrl) => inspectSearchEvidence(script(payload), loadedUrl, requestedUrl);

test('explicit zero count plus final empty main connection confirms source empty', () => {
    assert.deepEqual(inspect(mainPayload()), { kind: 'empty', reason: 'confirmed_empty' });
    assert.deepEqual(inspectSearchEvidence(script({ boot: [{ payload: mainPayload() }] }), requestedUrl, requestedUrl), {
        kind: 'empty', reason: 'confirmed_empty',
    });
});

test('missing, malformed and incomplete main payloads never confirm empty', () => {
    for (const value of [null, {}, [], { data: {} }, { ad_library_main: null },
        { ad_library_main: {} }, mainPayload(null), mainPayload({}), mainPayload({ edges: null }),
        mainPayload({ edges: {} }), mainPayload({ edges: [] }),
        mainPayload({ edges: [], count: 0 }), mainPayload({ edges: [], page_info: { has_next_page: false } }),
        mainPayload({ edges: [], count: '0', page_info: { has_next_page: false } }),
        mainPayload({ edges: [], count: 0, page_info: { has_next_page: 'false' } })]) {
        assert.equal(inspect(value).kind, 'unknown');
    }
    assert.equal(inspectSearchEvidence('<script type="application/json">not-json</script>', requestedUrl, requestedUrl).kind, 'unknown');
    assert.equal(inspectSearchEvidence('<script type="application/json">{"ad_library_main":</script>', requestedUrl, requestedUrl).kind, 'unknown');
    assert.equal(inspectSearchEvidence('<body>No ad cards rendered</body>', requestedUrl, requestedUrl).kind, 'unknown');
});

test('generic unrelated ads and empty arrays outside main do not establish search coverage', () => {
    for (const value of [{ ads: [] }, { edges: [], count: 0, page_info: { has_next_page: false } },
        { search_results_connection: emptyConnection() },
        { ads: [{ ad_archive_id: '123456789', snapshot: { page_name: 'Other advertiser' } }] }]) {
        assert.deepEqual(inspect(value), { kind: 'unknown', reason: 'unverified_zero' });
    }
});

test('contradictory count and continuation cannot confirm empty', () => {
    for (const connection of [{ edges: [], count: 1, page_info: { has_next_page: false } },
        { edges: [], count: 0, page_info: { has_next_page: true } },
        { edges: [{ node: {} }], count: 0, page_info: { has_next_page: false } }]) {
        assert.equal(inspect(mainPayload(connection)).kind, 'unknown');
    }
});

test('explicit result connections distinguish continuing and final observed results', () => {
    const edges = [{ node: { collated_results: [{ ad_archive_id: '123456789' }] } }];
    assert.deepEqual(inspect(mainPayload({ edges, count: 1, page_info: { has_next_page: false } })), {
        kind: 'exhausted', reason: 'observed_results',
    });
    assert.deepEqual(inspect(mainPayload({ edges, count: 1, page_info: { has_next_page: true } })), {
        kind: 'results', reason: 'observed_results',
    });
    assert.equal(inspect(mainPayload({ edges, count: 1 })).kind, 'results');
});

test('conflicting or unverified main payloads veto another explicit empty connection', () => {
    const nonempty = mainPayload({ edges: [{ node: {} }], count: 1, page_info: { has_next_page: false } });
    const html = script(mainPayload()) + script(nonempty);
    assert.deepEqual(inspectSearchEvidence(html, requestedUrl, requestedUrl), {
        kind: 'unknown', reason: 'contradictory_payload',
    });
    assert.equal(inspectSearchEvidence(script(mainPayload()) + script(mainPayload({})), requestedUrl, requestedUrl).kind, 'unknown');
    assert.equal(inspectSearchEvidence(script(mainPayload()) + '<script type="application/json">{"ad_library_main":</script>', requestedUrl, requestedUrl).kind, 'unknown');
    assert.equal(inspectSearchEvidence(script(mainPayload()) + script(mainPayload()), requestedUrl, requestedUrl).kind, 'empty');
});

test('error signals at ancestor, main and connection veto apparent empty data', () => {
    for (const error of [{ error: 'PRIVATE_SOURCE_ERROR' }, { errors: ['PRIVATE_SOURCE_ERROR'] },
        { errors: {} }, { success: false }, { ok: false }, { error_code: 7 },
        { status: ' ERROR ' }, { status: 'failed' }, { status: 429 }, { statusCode: 503 }, { status_code: 400 }]) {
        for (const payload of [{ ...mainPayload(), ...error },
            { ad_library_main: { search_results_connection: emptyConnection(), ...error } },
            mainPayload({ ...emptyConnection(), ...error })]) {
            assert.deepEqual(inspect(payload), { kind: 'unknown', reason: 'source_error' });
        }
    }
    assert.equal(inspect({ ...mainPayload(), error: null, errors: [], success: true, error_code: 0 }).kind, 'empty');
});

test('requested query, page ID and every supported filter must match loaded URL scope', () => {
    for (const [key, value] of [['q', 'Other'], ['country', 'GB'], ['active_status', 'all'],
        ['ad_type', 'political'], ['search_type', 'page'], ['media_type', 'video'],
        ['category', '2'], ['view_all_page_id', '123456789'], ['publisher_platforms[0]', 'instagram']]) {
        const loaded = new URL(requestedUrl);
        loaded.searchParams.set(key, value);
        assert.deepEqual(inspect(mainPayload(), loaded.href), { kind: 'unknown', reason: 'search_scope_changed' });
    }
    const missingQuery = new URL(requestedUrl);
    missingQuery.searchParams.delete('q');
    assert.equal(inspect(mainPayload(), missingQuery.href).kind, 'unknown');
    const pageUrl = 'https://www.facebook.com/ads/library/?view_all_page_id=123456789&country=US';
    const wrongPageUrl = pageUrl.replace('123456789', '987654321');
    assert.equal(inspectSearchEvidence(script(mainPayload()), wrongPageUrl, pageUrl).kind, 'unknown');
});

test('scope comparisons reject duplicate query values but tolerate order and unrelated tracking keys', () => {
    const reordered = new URL(requestedUrl);
    reordered.searchParams.sort();
    reordered.searchParams.set('fbclid', 'PRIVATE_TRACKING_TOKEN');
    assert.equal(inspect(mainPayload(), reordered.href).kind, 'empty');
    reordered.searchParams.append('q', 'Nike');
    assert.equal(inspect(mainPayload(), reordered.href).kind, 'unknown');
});

test('redirected, unsafe and malformed URLs never certify an empty requested search', () => {
    for (const loadedUrl of ['not-a-url', requestedUrl.replace('https:', 'http:'),
        requestedUrl.replace('www.facebook.com', 'www.facebook.com.evil.invalid'),
        requestedUrl.replace('/ads/library/', '/other/'), 'https://www.facebook.com/ads/library/']) {
        assert.equal(inspect(mainPayload(), loadedUrl).kind, 'unknown');
    }
    assert.equal(inspectSearchEvidence(script(mainPayload()), requestedUrl, 'not-a-url').kind, 'unknown');
    assert.equal(inspect(mainPayload(), requestedUrl.replace('www.facebook.com', 'm.facebook.com')).kind, 'empty');
});

test('login, challenge, consent and password-form evidence outrank empty fixtures', () => {
    for (const path of ['/login/', '/checkpoint/', '/challenge/', '/consent/']) {
        assert.deepEqual(inspect(mainPayload(), `https://www.facebook.com${path}`), { kind: 'blocked', reason: 'blocked' });
    }
    for (const blockedHtml of ['<input type="password" name="pass">', '<form action="/login/?next=private">']) {
        assert.deepEqual(inspectSearchEvidence(blockedHtml + script(mainPayload()), requestedUrl, requestedUrl), {
            kind: 'blocked', reason: 'blocked',
        });
    }
});

test('every unique planned job must explicitly confirm empty for an empty run', () => {
    const reporter = new RunReporter(['search-1', 'search-2']);
    for (const jobId of ['search-1', 'search-2']) {
        reporter.begin(jobId, 0);
        reporter.finish(jobId, 'empty', 'confirmed_empty');
    }
    const summary = reporter.summary();
    assert.equal(summary.outcome, 'empty');
    assert.equal(summary.savedAds, 0);
    assert.equal(summary.confirmedEmptySearches, 2);
    assert.equal(summary.plannedSearches, 2);
    assert.equal(summary.startedSearches, 2);
    assert.equal(summary.exhaustiveArchive, false);
});

test('empty plus failed or unstarted searches is failed zero rather than confirmed empty', () => {
    for (const failSecond of [false, true]) {
        const reporter = new RunReporter(['search-1', 'search-2']);
        reporter.begin('search-1', 0);
        reporter.finish('search-1', 'empty', 'confirmed_empty');
        if (failSecond) reporter.finish('search-2', 'failed', 'request_failed', 3);
        const summary = reporter.summary();
        assert.equal(summary.outcome, 'failed');
        assert.equal(summary.confirmedEmptySearches, 1);
        assert.equal(summary.failedSearches, 1);
        assert.equal(summary.savedAds, 0);
    }
    assert.equal(new RunReporter([]).summary().outcome, 'failed');
});

test('saved public rows survive failed other searches as partial output', () => {
    const reporter = new RunReporter(['search-1', 'search-2']);
    const saved = reporter.begin('search-1', 0);
    saved.savedAds = 2;
    saved.candidateScans = 4;
    reporter.finish('search-1', 'results', 'observed_results');
    reporter.finish('search-2', 'failed', 'blocked', 3);
    const summary = reporter.summary();
    assert.equal(summary.outcome, 'partial');
    assert.equal(summary.savedAds, 2);
    assert.equal(summary.failedSearches, 1);
    assert.equal(summary.retries, 3);
    assert.equal(summary.jobs[1].attempts, 0);
});

test('recovered retries remain one job and preserve saved counters across attempts', () => {
    const reporter = new RunReporter(['search-1']);
    const first = reporter.begin('search-1', 0);
    first.savedAds = 1;
    first.candidateScans = 3;
    const recovered = reporter.begin('search-1', 1);
    assert.equal(recovered.savedAds, 1);
    assert.equal(recovered.candidateScans, 3);
    reporter.finish('search-1', 'results', 'observed_results', 1);
    const summary = reporter.summary();
    assert.equal(summary.outcome, 'results');
    assert.equal(summary.plannedSearches, 1);
    assert.equal(summary.startedSearches, 1);
    assert.equal(summary.failedSearches, 0);
    assert.equal(summary.savedAds, 1);
    assert.equal(summary.jobs[0].attempts, 2);
    assert.equal(summary.retries, 1);
});

test('a recovered empty retry is not a terminal failed search', () => {
    const reporter = new RunReporter(['search-1']);
    reporter.begin('search-1', 0);
    reporter.begin('search-1', 1);
    reporter.finish('search-1', 'empty', 'confirmed_empty', 1);
    assert.equal(reporter.summary().outcome, 'empty');
    assert.equal(reporter.summary().failedSearches, 0);
    assert.equal(reporter.summary().retries, 1);
});

test('spending limit before any saved ad is limited zero, including untouched jobs', () => {
    const reporter = new RunReporter(['search-1', 'search-2']);
    reporter.begin('search-1', 0).candidateScans = 1;
    reporter.finish('search-1', 'limited', 'spending_limit');
    const summary = reporter.summary({ spendingLimitReached: true });
    assert.equal(summary.outcome, 'limited');
    assert.equal(summary.savedAds, 0);
    assert.equal(summary.limitedSearches, 2);
    assert.equal(summary.failedSearches, 0);
    assert.equal(summary.confirmedEmptySearches, 0);
    assert.equal(summary.jobs[1].reason, 'spending_limit');
});

test('result and heuristic scroll limits are not confirmed source empty', () => {
    for (const reason of ['max_results', 'stale_scroll', 'no_new_data'] as const) {
        const reporter = new RunReporter(['search-1']);
        reporter.begin('search-1', 0);
        reporter.finish('search-1', 'limited', reason);
        assert.equal(reporter.summary().outcome, 'limited');
        assert.equal(reporter.summary().confirmedEmptySearches, 0);
    }
});

test('navigation failure before router preserves planned job and retry accounting', () => {
    const reporter = new RunReporter(['search-1']);
    reporter.finish('search-1', 'failed', 'request_failed', 3);
    const summary = reporter.summary();
    assert.equal(summary.outcome, 'failed');
    assert.equal(summary.plannedSearches, 1);
    assert.equal(summary.startedSearches, 0);
    assert.equal(summary.failedSearches, 1);
    assert.equal(summary.retries, 3);
});

test('fatal billing or crawl failures preserve saved counts without certifying full coverage', () => {
    for (const fatalReason of ['save_error', 'crawl_error'] as const) {
        const reporter = new RunReporter(['search-1', 'search-2']);
        reporter.begin('search-1', 0).savedAds = 1;
        const summary = reporter.summary({ fatalReason });
        assert.equal(summary.outcome, 'partial');
        assert.equal(summary.savedAds, 1);
        assert.equal(summary.fatalReason, fatalReason);
        assert.equal(summary.failedSearches, 2);
        assert.equal(summary.exhaustiveArchive, false);
        assert.equal(new RunReporter(['search-1']).summary({ fatalReason }).outcome, 'failed');
    }
});

test('summary snapshots do not mutate pending jobs or share returned job references', () => {
    const reporter = new RunReporter(['search-1']);
    const first = reporter.summary({ spendingLimitReached: true });
    assert.equal(reporter.job('search-1').outcome, 'pending');
    first.jobs[0].savedAds = 100;
    assert.equal(reporter.summary().savedAds, 0);
    reporter.begin('search-1', 0);
    assert.equal(reporter.job('search-1').savedAds, 0);
});

test('duplicate and unknown job identities are rejected with fixed non-sensitive errors', () => {
    assert.throws(() => new RunReporter(['search-1', 'search-1']), /Duplicate Facebook search job ID\./);
    const reporter = new RunReporter(['search-1']);
    for (const operation of [() => reporter.job('PRIVATE_QUERY'), () => reporter.begin('PRIVATE_QUERY', 0),
        () => reporter.finish('PRIVATE_QUERY', 'failed', 'request_failed')]) {
        assert.throws(operation, (error: Error) => error.message === 'Unknown Facebook search job ID.');
    }
});

test('summary fields and evidence errors expose fixed categories, not page content or URLs', () => {
    const privateMarker = 'PRIVATE_TOKEN_CONTACT_COOKIE';
    const evidence = inspect({ ...mainPayload(), error: { message: privateMarker, cookie: privateMarker } });
    assert.deepEqual(evidence, { kind: 'unknown', reason: 'source_error' });
    const evidenceError = new SearchEvidenceError(evidence.reason);
    assert.equal(evidenceError.message, 'Facebook search could not be verified (source_error).');
    const reporter = new RunReporter(['search-1']);
    reporter.begin('search-1', 0);
    reporter.finish('search-1', 'failed', evidence.reason, 3);
    const summary = reporter.summary();
    assert.deepEqual(Object.keys(summary).sort(), ['schemaVersion', 'outcome', 'savedAds', 'plannedSearches',
        'startedSearches', 'failedSearches', 'confirmedEmptySearches', 'limitedSearches', 'retries',
        'spendingLimitReached', 'fatalReason', 'exhaustiveArchive', 'jobs'].sort());
    assert.deepEqual(Object.keys(summary.jobs[0]).sort(), ['jobId', 'outcome', 'reason', 'attempts',
        'retries', 'savedAds', 'candidateScans'].sort());
    const serialized = JSON.stringify({ evidence, errorMessage: evidenceError.message, summary });
    assert.ok(!serialized.includes(privateMarker));
    assert.doesNotMatch(serialized, /https?:|<script|searchQuery|proxyUrl|cookie|authorization|adCreativeText/i);
});
