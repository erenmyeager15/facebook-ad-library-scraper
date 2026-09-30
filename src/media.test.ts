import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Page, Request, Response } from 'playwright';
import { createAdMediaCollector, isPublicAdDataRequest, parsePublicAdMedia } from './media.js';
import { parsePublicAdPayload, recoverAdMedia } from './routes.js';

const url = 'https://www.facebook.com/ads/library/?q=Nike&country=US&active_status=active';
const endpoint = 'https://www.facebook.com/api/graphql/';
const ad = (id = '123456789') => ({ ad_archive_id: id, snapshot: {
    page_name: 'Nike', body: { text: 'Nike public creative' },
    images: [{ original_image_url: `https://scontent.xx.fbcdn.net/${id}.jpg` }],
    videos: [{ video_sd_url: `https://video.xx.fbcdn.net/${id}.mp4`,
        video_preview_image_url: `https://scontent.xx.fbcdn.net/${id}-poster.jpg` }],
} });
const payload = (...ads: unknown[]) => ({ data: { ad_library_main: {
    search_results_connection: { edges: ads.map((value) => ({ node: { collated_results: [value] } })) },
} } });

test('reads normal, XSSI-prefixed, pretty and streamed public media payloads', () => {
    for (const text of [JSON.stringify(payload(ad())), JSON.stringify(payload(ad()), null, 2),
        `for (;;);${JSON.stringify(payload(ad()))}`,
        `)]}',\n${JSON.stringify(payload(ad()))}`,
        `${JSON.stringify({ unrelated: [] })}\n${JSON.stringify(payload(ad()))}`]) {
        const media = parsePublicAdMedia(text);
        assert.equal(media.size, 1);
        assert.equal(media.get('123456789')?.videoUrl, 'https://video.xx.fbcdn.net/123456789.mp4');
        assert.equal(media.get('123456789')?.videoThumbnailUrl, 'https://scontent.xx.fbcdn.net/123456789-poster.jpg');
        assert.deepEqual(Object.keys(media.get('123456789')!).sort(), ['adId', 'imageUrls', 'videoThumbnailUrl', 'videoUrl']);
    }
});

test('bounds retained media, deduplicates IDs and ignores malformed/oversized data', () => {
    assert.equal(parsePublicAdMedia(JSON.stringify(payload(ad(), ad(), ad('223456789'))), 1).size, 1);
    for (const text of ['not-json', '<html>login</html>', 'x'.repeat(1_500_001), Array(257).fill('{}').join('\n')]) {
        assert.equal(parsePublicAdMedia(text).size, 0);
    }
    assert.equal(parsePublicAdMedia(JSON.stringify(payload(ad())), 0).size, 0);
});

test('drops executable, inline and blob media URLs without retaining creative text', () => {
    const unsafe = ad();
    unsafe.snapshot.images[0].original_image_url = 'javascript:fixture()';
    unsafe.snapshot.videos[0].video_sd_url = 'blob:https://www.facebook.com/private';
    unsafe.snapshot.videos[0].video_preview_image_url = 'data:image/png;base64,fixture';
    assert.equal(parsePublicAdMedia(JSON.stringify(payload(unsafe))).size, 0);
});

test('restores missing video fields only on the same observed ad and preserves existing URLs', () => {
    const record = parsePublicAdPayload(payload(ad()), 'Nike', ['facebook'])[0];
    const media = parsePublicAdMedia(JSON.stringify(payload(ad()))).get(record.adId!);
    const imageOnly = { ...record, videoUrl: null, videoThumbnailUrl: null, adType: 'image' };
    const recovered = recoverAdMedia(imageOnly, media);
    assert.equal(recovered.videoUrl, record.videoUrl);
    assert.equal(recovered.videoThumbnailUrl, record.videoThumbnailUrl);
    assert.equal(recovered.adType, 'video');
    assert.equal(recovered.adCreativeText, imageOnly.adCreativeText);
    assert.deepEqual(recovered.imageUrls, imageOnly.imageUrls);
    assert.equal(recoverAdMedia(imageOnly, { ...media!, adId: 'other' }), imageOnly);
    const preferred = { ...record, videoUrl: 'https://video.xx.fbcdn.net/observed.mp4' };
    assert.equal(recoverAdMedia(preferred, media).videoUrl, preferred.videoUrl);
});

test('only accepts HTTPS Meta GraphQL xhr/fetch requests, not arbitrary assets or hosts', () => {
    assert.equal(isPublicAdDataRequest(endpoint, 'fetch'), true);
    assert.equal(isPublicAdDataRequest(endpoint, 'xhr'), true);
    for (const [value, type] of [[endpoint, 'document'], [endpoint, 'script'],
        ['http://www.facebook.com/api/graphql/', 'fetch'],
        ['https://www.facebook.com.evil.test/api/graphql/', 'fetch'],
        ['https://www.facebook.com/api/other/', 'fetch']]) {
        assert.equal(isPublicAdDataRequest(value, type), false);
    }
});

function harness() {
    let loadedUrl = url;
    const events = new EventEmitter();
    const page = Object.assign(events, { url: () => loadedUrl }) as unknown as Page;
    const collector = createAdMediaCollector(page, url, 25);
    const request = (requestUrl = endpoint) => ({ url: () => requestUrl, resourceType: () => 'fetch' }) as unknown as Request;
    const response = (req: Request, body: () => Promise<string>, status = 200, length?: number) => ({
        request: () => req, text: body, status: () => status,
        headers: () => length ? { 'content-length': String(length) } : {},
    }) as unknown as Response;
    return { events, collector, request, response, setUrl(value: string) { loadedUrl = value; } };
}

test('collects already-requested matching-scope media and detaches on page close', async () => {
    const h = harness();
    const req = h.request();
    h.events.emit('request', req);
    h.events.emit('response', h.response(req, async () => JSON.stringify(payload(ad()))));
    assert.equal((await h.collector.read()).size, 1);
    assert.deepEqual(h.collector.counts(), { capturedResponses: 1, discardedResponses: 0, storedAds: 1, withVideo: 1 });
    h.events.emit('close');
    assert.equal(h.events.listenerCount('request'), 0);
    assert.equal(h.events.listenerCount('response'), 0);
    assert.equal((await h.collector.read()).size, 0);
});

test('warm-up, foreign, failed and oversized responses do not enter the media registry', async () => {
    const h = harness();
    const emit = (req: Request, status = 200, length?: number) => {
        h.events.emit('request', req);
        h.events.emit('response', h.response(req, async () => JSON.stringify(payload(ad())), status, length));
    };
    h.setUrl('https://www.facebook.com/ads/library/');
    emit(h.request());
    h.setUrl(url);
    emit(h.request('https://example.test/api/graphql/'));
    emit(h.request(), 403);
    emit(h.request(), 200, 1_500_001);
    assert.equal((await h.collector.read()).size, 0);
    h.collector.dispose();
});

test('response bodies completing after scope changes are discarded', async () => {
    const h = harness();
    let resolve!: (value: string) => void;
    const body = new Promise<string>((done) => { resolve = done; });
    const req = h.request();
    h.events.emit('request', req);
    h.events.emit('response', h.response(req, () => body));
    h.setUrl(url.replace('q=Nike', 'q=Other'));
    resolve(JSON.stringify(payload(ad())));
    assert.equal((await h.collector.read()).size, 0);
    h.collector.dispose();
});

test('bounded media cache admits later pagination instead of permanently retaining the first batch', async () => {
    const h = harness();
    const emit = async (ads: unknown[]) => {
        const req = h.request();
        h.events.emit('request', req);
        h.events.emit('response', h.response(req, async () => JSON.stringify(payload(...ads))));
        return await h.collector.read();
    };
    const first = await emit(Array.from({ length: 500 }, (_, index) => ad(String(100000000 + index))));
    assert.equal(first.size, 500);
    const firstToEvict = first.keys().next().value!;
    const later = await emit([ad('999999999')]);
    assert.equal(later.size, 500);
    assert.equal(later.has('999999999'), true);
    assert.equal(later.has(firstToEvict), false);
    h.collector.dispose();
});

test('a 25-result search retains visible video metadata while Meta preloads another hundred ads', async () => {
    const h = harness();
    const emit = async (ads: unknown[]) => {
        const req = h.request();
        h.events.emit('request', req);
        h.events.emit('response', h.response(req, async () => JSON.stringify(payload(...ads))));
        return await h.collector.read();
    };
    await emit(Array.from({ length: 30 }, (_, index) => ad(String(100000000 + index))));
    const prefetched = await emit(Array.from({ length: 100 }, (_, index) => ad(String(200000000 + index))));
    assert.equal(prefetched.size, 130);
    for (let i = 0; i < 25; i++) assert.ok(prefetched.get(String(100000000 + i))?.videoUrl);
    h.collector.dispose();
});

test('bounds simultaneous response reads and swallows provider errors without exposing their text', async () => {
    const h = harness();
    let resolve!: (value: string) => void;
    const body = new Promise<string>((done) => { resolve = done; });
    for (let i = 0; i < 4; i++) {
        const req = h.request();
        h.events.emit('request', req);
        h.events.emit('response', h.response(req, () => body));
    }
    resolve(JSON.stringify(payload(ad())));
    await h.collector.read();
    assert.equal(h.collector.counts().discardedResponses, 1);
    const req = h.request();
    h.events.emit('request', req);
    h.events.emit('response', h.response(req, async () => { throw new Error('private-provider-error'); }));
    await h.collector.read();
    assert.equal(h.collector.counts().discardedResponses, 2);
    assert.equal(JSON.stringify(h.collector.counts()).includes('private-provider-error'), false);
    h.collector.dispose();
});
