import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { classifySearchError, createPageWarmup, createSearchNavigation, isBadExitError, scopeDiagnostic } from './navigation.js';
import { SearchEvidenceError } from './reporting.js';

const url = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active';
const landing = 'https://www.facebook.com/ads/library/';
const noWait = async () => {};
function harness() {
    let loaded = url;
    let status = 200;
    let body = '<html>Public search</html>';
    let failure: Error | null = null;
    let failGoto = false;
    let gotos = 0;
    let reads = 0;
    let onContent: (() => void) | undefined;
    const page = {
        url: () => loaded,
        goto: async (value: string) => {
            gotos += 1;
            if (failGoto) throw new Error('secret provider URL');
            loaded = value;
            return { status: () => status };
        },
        content: async () => {
            reads += 1;
            if (failure) { const error = failure; failure = null; throw error; }
            onContent?.();
            return body;
        },
        locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as unknown as Page;
    return { page, setUrl(value: string) { loaded = value; }, setBody(value: string) { body = value; },
        setStatus(value: number) { status = value; }, failRead(error: Error) { failure = error; },
        failNavigation(value: boolean) { failGoto = value; },
        duringContent(callback: () => void) { onContent = callback; },
        gotos: () => gotos, reads: () => reads };
}

test('every fresh retry page warms independently, and successful same-page warm-up is bounded', async () => {
    const warmup = createPageWarmup();
    const first = harness();
    const retry = harness();
    assert.equal(await warmup(first.page), true);
    assert.equal(await warmup(first.page), true);
    assert.equal(await warmup(retry.page), true);
    assert.equal(first.gotos(), 1);
    assert.equal(retry.gotos(), 1);
});

test('a failed or blocked warm-up is not permanently marked successful', async () => {
    const warmup = createPageWarmup();
    const h = harness();
    h.failNavigation(true);
    assert.equal(await warmup(h.page), false);
    h.failNavigation(false);
    h.setStatus(403);
    assert.equal(await warmup(h.page), false);
    h.setStatus(200);
    assert.equal(await warmup(h.page), true);
    assert.equal(h.gotos(), 3);
});

test('stable requested searches require two scoped snapshots and no extra navigation', async () => {
    const h = harness();
    const snapshot = await createSearchNavigation({ wait: noWait })(h.page, url);
    assert.equal(snapshot.url, url);
    assert.equal(h.reads(), 2);
    assert.equal(h.gotos(), 0);
});

test('a same-library scope reset gets exactly one recovery to the original query and filters', async () => {
    const h = harness();
    h.setUrl(landing);
    const diagnostics: unknown[] = [];
    const read = createSearchNavigation({ wait: noWait, onRecovery: (value) => diagnostics.push(value) });
    assert.equal((await read(h.page, url)).url, url);
    assert.equal(h.gotos(), 1);
    assert.deepEqual(diagnostics, [{ loadedPage: 'ad_library', changedKeys: ['q', 'active_status', 'country'] }]);
    h.setUrl(landing);
    await assert.rejects(read(h.page, url), (error: unknown) => error instanceof SearchEvidenceError
        && error.reason === 'search_scope_changed');
    assert.equal(h.gotos(), 1);
});

test('login, foreign, unsafe and non-library redirects are never recovered or accepted', async () => {
    for (const value of ['https://www.facebook.com/login/', 'https://www.facebook.com/checkpoint/',
        'https://evil.test/ads/library/', 'http://www.facebook.com/ads/library/', 'https://www.facebook.com/']) {
        const h = harness();
        h.setUrl(value);
        await assert.rejects(createSearchNavigation({ wait: noWait })(h.page, url), SearchEvidenceError);
        assert.equal(h.gotos(), 0);
    }
});

test('blocked HTML and failed recovery HTTP responses still fail safely', async () => {
    const h = harness();
    h.setBody('<input name="pass">');
    await assert.rejects(createSearchNavigation({ wait: noWait })(h.page, url),
        (error: unknown) => error instanceof SearchEvidenceError && error.reason === 'blocked');
    for (const status of [403, 500]) {
        const retry = harness();
        retry.setUrl(landing);
        retry.setStatus(status);
        await assert.rejects(createSearchNavigation({ wait: noWait })(retry.page, url), SearchEvidenceError);
        assert.equal(retry.gotos(), 1);
    }
});

test('transient content navigation errors are retried without storing the raw error', async () => {
    const h = harness();
    h.failRead(new Error('Execution context was destroyed, most likely because of a navigation secret-url'));
    assert.equal((await createSearchNavigation({ wait: noWait })(h.page, url)).url, url);
    assert.equal(h.gotos(), 0);
    h.failRead(new Error('secret unrelated failure'));
    await assert.rejects(createSearchNavigation({ wait: noWait })(h.page, url),
        (error: unknown) => error instanceof SearchEvidenceError && error.reason === 'request_failed'
            && !error.message.includes('secret'));
});

test('a URL change during content capture discards the snapshot before extraction', async () => {
    const h = harness();
    let changed = false;
    h.duringContent(() => { if (!changed) { changed = true; h.setUrl(landing); } });
    assert.equal((await createSearchNavigation({ wait: noWait })(h.page, url)).url, url);
    assert.equal(h.gotos(), 1);
});

test('continuous navigation has a finite read budget and never yields a snapshot', async () => {
    const h = harness();
    let flip = false;
    h.duringContent(() => { flip = !flip; h.setUrl(flip ? `${url}&tracking=1` : url); });
    await assert.rejects(createSearchNavigation({ wait: noWait })(h.page, url),
        (error: unknown) => error instanceof SearchEvidenceError && error.reason === 'navigation_interrupted');
    assert.equal(h.reads(), 8);
    assert.equal(h.gotos(), 0);
});

test('scope diagnostics retain only fixed key names, not query values, URLs or foreign hosts', () => {
    const result = scopeDiagnostic('https://secret-host.test/ads/library/?q=secret&country=IN&token=secret', url);
    assert.deepEqual(result, { loadedPage: 'other', changedKeys: ['q', 'active_status', 'country'] });
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('terminal navigation errors retain their own fixed reason rather than a stale prior scope error', () => {
    assert.equal(classifySearchError(new Error('page.$: Execution context was destroyed secret-url')), 'navigation_interrupted');
    assert.equal(classifySearchError(new Error('Target page, context or browser has been closed')), 'navigation_interrupted');
    assert.equal(classifySearchError(new Error('secret-unrelated-error')), 'request_failed');
    assert.equal(classifySearchError(new SearchEvidenceError('blocked')), 'blocked');
});

test('network and TLS failures from a bad proxy exit trigger session rotation', () => {
    for (const message of [
        'page.goto: net::ERR_CERT_COMMON_NAME_INVALID at https://www.facebook.com/ads/library/?q=Nike',
        'page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://www.facebook.com/ads/library/',
        'page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://www.facebook.com/ads/library/',
        'page.goto: net::ERR_CONNECTION_RESET at https://www.facebook.com/ads/library/',
        'page.goto: net::ERR_TIMED_OUT at https://www.facebook.com/ads/library/',
        'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.facebook.com/ads/library/',
        'page.goto: Timeout 90000ms exceeded.',
        'Navigation timed out after 90 seconds.',
    ]) {
        assert.equal(isBadExitError(new Error(message)), true, message);
    }
});

test('Facebook content, scope and block errors do not rotate the proxy session', () => {
    assert.equal(isBadExitError(new SearchEvidenceError('blocked')), false);
    assert.equal(isBadExitError(new SearchEvidenceError('search_scope_changed')), false);
    assert.equal(isBadExitError(new Error('Execution context was destroyed, most likely because of a navigation')), false);
    assert.equal(isBadExitError(new Error('Facebook search failed (unverified_or_failed_search)')), false);
    assert.equal(isBadExitError('net::ERR_CERT_COMMON_NAME_INVALID'), false);
});
