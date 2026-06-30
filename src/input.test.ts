import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchUrl, normalizeActorInput } from './input.js';

test('normalizes empty input to a one-result residential sample', () => {
    const input = normalizeActorInput({});

    assert.deepEqual(input.keywords, ['Nike']);
    assert.deepEqual(input.pageIds, []);
    assert.deepEqual(input.advertiserNames, []);
    assert.equal(input.country, 'US');
    assert.equal(input.adStatus, 'active');
    assert.deepEqual(input.platforms, ['facebook', 'instagram']);
    assert.equal(input.maxResults, 1);
    assert.deepEqual(input.proxyConfiguration, {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    });
});

test('cleans filters, clamps max results, and preserves explicit proxy-off input', () => {
    const input = normalizeActorInput({
        keywords: [' Nike ', 'Nike', 'running shoes'],
        pageIds: ['123456'],
        advertiserNames: [],
        country: 'gb',
        platforms: ['facebook', 'unknown', 'instagram'],
        maxResults: 5000,
        proxyConfiguration: { useApifyProxy: false },
    });

    assert.deepEqual(input.keywords, ['Nike', 'running shoes']);
    assert.deepEqual(input.pageIds, ['123456']);
    assert.equal(input.country, 'GB');
    assert.deepEqual(input.platforms, ['facebook', 'instagram']);
    assert.equal(input.maxResults, 1000);
    assert.deepEqual(input.proxyConfiguration, { useApifyProxy: false });
});

test('rejects invalid page IDs and overly broad search grids', () => {
    assert.throws(() => normalizeActorInput({ pageIds: ['abc123'] }), /Page ID must be numeric/);

    assert.throws(
        () =>
            normalizeActorInput({
                keywords: ['a', 'b', 'c', 'd', 'e'],
                pageIds: ['10000', '10001', '10002', '10003', '10004'],
                advertiserNames: ['one'],
            }),
        /maximum is 10/,
    );
});

test('never expands maxResults zero into an unlimited crawl', () => {
    const input = normalizeActorInput({ keywords: ['Nike'], maxResults: 0 });

    assert.equal(input.maxResults, 1);
});

test('builds keyword and page search URLs', () => {
    const input = normalizeActorInput({
        keywords: ['Nike'],
        country: 'US',
        platforms: ['facebook', 'instagram'],
        maxResults: 1,
    });
    const keywordUrl = new URL(buildSearchUrl('Nike', input));
    const pageUrl = new URL(buildSearchUrl('', input, '123456789'));

    assert.equal(keywordUrl.origin + keywordUrl.pathname, 'https://www.facebook.com/ads/library/');
    assert.equal(keywordUrl.searchParams.get('q'), 'Nike');
    assert.equal(keywordUrl.searchParams.get('active_status'), 'active');
    assert.equal(keywordUrl.searchParams.get('country'), 'US');
    assert.equal(keywordUrl.searchParams.get('publisher_platforms[0]'), 'facebook');
    assert.equal(keywordUrl.searchParams.get('publisher_platforms[1]'), 'instagram');
    assert.equal(pageUrl.searchParams.get('view_all_page_id'), '123456789');
    assert.equal(pageUrl.searchParams.has('q'), false);
});
