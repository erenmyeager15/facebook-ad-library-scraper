import assert from 'node:assert/strict';
import test from 'node:test';
import { blockMediaDownloads, BLOCKED_MEDIA_URL_PATTERNS, FACEBOOK_BROWSER_LIMITS } from './performance.js';
import { waitForAdPreviews } from './performance.js';
import type { PlaywrightCrawlingContext } from 'crawlee';
import { SearchEvidenceError } from './reporting.js';

// DevTools URL patterns support only '*' wildcards. Use this matcher to guard
// our deliberately narrow policy, not as a replacement for Chromium blocking.
function blocked(url: string): boolean {
    return BLOCKED_MEDIA_URL_PATTERNS.some((pattern) => new RegExp(`^${pattern
        .split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(url));
}

test('blocks video binaries and extensionless video-host payloads', () => {
    for (const url of [
        'https://video.xx.fbcdn.net/v/ad.mp4?signature=fixture',
        'https://video-iad3-1.xx.fbcdn.net/v/stream',
    ]) assert.equal(blocked(url), true, url);
});

test('preserves preview images even when initial matching media metadata is missing', () => {
    for (const url of [
        'https://scontent.xx.fbcdn.net/v/t39/ad.jpg?token=fixture',
        'https://scontent-iad3-1.xx.fbcdn.net/v/ad.webp',
        'https://scontent.xx.fbcdn.net/media/extensionless',
        'https://external.xx.fbcdn.net/safe_image.php?url=fixture',
    ]) assert.equal(blocked(url), false, url);
});

test('blocks Meta font binaries but leaves styles and UI icons available', () => {
    for (const extension of ['woff', 'woff2', 'ttf', 'otf']) {
        assert.equal(blocked(`https://static.xx.fbcdn.net/rsrc/font.${extension}?version=1`), true);
    }
    for (const path of ['style.css', 'style.css?asset=font', 'icon.svg', 'control.png', 'app.js']) {
        assert.equal(blocked(`https://static.xx.fbcdn.net/rsrc/${path}`), false);
    }
});

test('preserves search documents, query filters, consent, scripts and data requests', () => {
    for (const url of [
        'https://www.facebook.com/ads/library/',
        'https://www.facebook.com/ads/library/?q=photo.jpg&country=US',
        'https://www.facebook.com/privacy/consent/',
        'https://www.facebook.com/api/graphql/',
        'https://www.facebook.com/api/graphql/?creative_url=https%3A%2F%2Fscontent.xx.fbcdn.net%2Fad.png',
        'https://static.xx.fbcdn.net/rsrc/bootloader.js',
        'https://connect.facebook.net/en_US/sdk.js',
    ]) assert.equal(blocked(url), false, url);
});

test('supplies an explicit policy instead of the CSS-blocking Crawlee defaults', async () => {
    let calls = 0;
    await blockMediaDownloads(async (options) => {
        calls += 1;
        assert.deepEqual(options, { urlPatterns: [...BLOCKED_MEDIA_URL_PATTERNS] });
        assert.equal(Object.hasOwn(options ?? {}, 'extraUrlPatterns'), false);
    });
    assert.equal(calls, 1);
});

test('blocking setup errors are not silently turned into a successful optimization', async () => {
    await assert.rejects(blockMediaDownloads(async () => { throw new Error('fixture setup failure'); }),
        /fixture setup failure/);
});

test('bounds browser search concurrency and open pages without raising RAM', () => {
    assert.deepEqual(FACEBOOK_BROWSER_LIMITS, { maxConcurrency: 1, maxOpenPagesPerBrowser: 1 });
});

test('preview readiness scopes polling to the bounded candidate batch', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    let scans = 0;
    let waits = 0;
    const page = { evaluate: async (_fn: unknown, options: unknown) => {
        assert.deepEqual(options, { excludedAdIds: ['123456789'], maxCandidates: 25,
            inspectPreviewsOnly: true, activateLazy: true });
        scans += 1;
        return { candidateAdIds: ['223456789'], pendingAdIds: scans === 1 ? ['223456789'] : [] };
    }, waitForTimeout: async (ms: number) => {
        assert.ok(ms > 0 && ms <= 100);
        waits += 1;
        t.mock.timers.tick(ms);
    } } as unknown as PlaywrightCrawlingContext['page'];
    const result = await waitForAdPreviews(page, { excludedAdIds: ['123456789'], maxCandidates: 25 });
    assert.deepEqual(result.pendingAdIds, []);
    assert.equal(scans, 12);
    assert.equal(waits, 11);
});

test('media-shape changes reset the preview settling window', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    let scans = 0;
    const page = { evaluate: async () => {
        scans += 1;
        return { candidateAdIds: ['223456789'], pendingAdIds: [], mediaStateKey: scans < 5 ? 'image' : 'video' };
    }, waitForTimeout: async (ms: number) => t.mock.timers.tick(ms) } as unknown as PlaywrightCrawlingContext['page'];
    const result = await waitForAdPreviews(page);
    assert.deepEqual(result.pendingAdIds, []);
    assert.equal(scans, 15);
});

test('lost preview document reports a fixed reason rather than raw provider details', async () => {
    const page = { evaluate: async () => { throw new Error('secret-preview-url'); } } as unknown as PlaywrightCrawlingContext['page'];
    await assert.rejects(waitForAdPreviews(page), (error: unknown) => error instanceof SearchEvidenceError
        && error.reason === 'preview_unready' && !error.message.includes('secret'));
});
