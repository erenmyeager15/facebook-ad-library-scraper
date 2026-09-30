import type { Page, Request, Response } from 'playwright';
import { inspectSearchEvidence } from './reporting.js';
import { parsePublicAdPayload, RecoveredAdMedia } from './routes.js';

const MAX_RESPONSE_CHARS = 1_500_000;
const MAX_STREAM_LINES = 256;
const MAX_PENDING_RESPONSES = 3;
const MAX_MEDIA_URLS = 10;
const validUrl = (value: string | null): string | null => {
    if (!value) return null;
    try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; }
    catch { return null; }
};

/** Only public ad snapshot media is retained, not raw bodies or request data. */
export function parsePublicAdMedia(text: string, maxRecords = 200): Map<string, RecoveredAdMedia> {
    const media = new Map<string, RecoveredAdMedia>();
    if (text.length > MAX_RESPONSE_CHARS || maxRecords <= 0) return media;
    const stripped = text.trim().replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '').replace(/^\)\]\}',?\s*/, '');
    let roots: unknown[];
    try { roots = [JSON.parse(stripped)]; }
    catch {
        const lines = stripped.split(/\r?\n/);
        if (lines.length > MAX_STREAM_LINES) return media;
        roots = lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    }
    for (const root of roots) {
        for (const record of parsePublicAdPayload(root, '', [])) {
            if (!record.adId || !/^\d{5,}$/.test(record.adId)) continue;
            const old = media.get(record.adId);
            if (!old && media.size >= maxRecords) continue;
            const imageUrls = record.imageUrls.map(validUrl).filter((url): url is string => Boolean(url));
            const value: RecoveredAdMedia = {
                adId: record.adId,
                imageUrls: [...new Set([...(old?.imageUrls ?? []), ...imageUrls])].slice(0, MAX_MEDIA_URLS),
                videoUrl: old?.videoUrl || validUrl(record.videoUrl),
                videoThumbnailUrl: old?.videoThumbnailUrl || validUrl(record.videoThumbnailUrl),
            };
            if (value.imageUrls.length || value.videoUrl || value.videoThumbnailUrl) media.set(record.adId, value);
        }
    }
    return media;
}

export function isPublicAdDataRequest(url: string, resourceType: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && ['www.facebook.com', 'facebook.com'].includes(parsed.hostname)
            && /^\/api\/graphql\/?$/.test(parsed.pathname) && ['xhr', 'fetch'].includes(resourceType);
    } catch { return false; }
}

export interface AdMediaCollector {
    read(): Promise<ReadonlyMap<string, RecoveredAdMedia>>;
    dispose(): void;
    counts(): { capturedResponses: number; discardedResponses: number; storedAds: number; withVideo: number };
}

/** Observe existing source requests only. Never fetch a new endpoint or media. */
export function createAdMediaCollector(page: Page, requestedUrl: string, maxRecords: number): AdMediaCollector {
    const records = new Map<string, RecoveredAdMedia>();
    const scoped = new WeakSet<Request>();
    const pending = new Set<Promise<void>>();
    // Meta can preload substantially more ads than the requested output cap.
    // Keep a bounded viewport-plus-prefetch window, not just maxResults * 2:
    // otherwise the first visible ads can be evicted before DOM extraction.
    const capacity = 500;
    let capturedResponses = 0;
    let discardedResponses = 0;
    let disposed = false;
    const inScope = () => inspectSearchEvidence('', page.url(), requestedUrl).reason === 'unverified_zero';
    const onRequest = (request: Request) => {
        if (isPublicAdDataRequest(request.url(), request.resourceType())
            && inScope()) scoped.add(request);
    };
    const onResponse = (response: Response) => {
        if (disposed || !inScope() || !scoped.has(response.request()) || response.status() !== 200) return;
        if (pending.size >= MAX_PENDING_RESPONSES) { discardedResponses += 1; return; }
        const contentLength = Number(response.headers()['content-length']);
        if (contentLength > MAX_RESPONSE_CHARS) { discardedResponses += 1; return; }
        const task = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const text = await Promise.race([
                    response.text(),
                    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('media_response_timeout')), 5000); }),
                ]);
                if (disposed || !inScope()) return;
                const media = parsePublicAdMedia(text, capacity);
                if (media.size) capturedResponses += 1;
                for (const [id, value] of media) {
                    const old = records.get(id);
                    if (old) records.delete(id);
                    else if (records.size >= capacity) records.delete(records.keys().next().value!);
                    records.set(id, {
                        adId: id,
                        imageUrls: [...new Set([...(old?.imageUrls ?? []), ...value.imageUrls])].slice(0, MAX_MEDIA_URLS),
                        videoUrl: old?.videoUrl || value.videoUrl,
                        videoThumbnailUrl: old?.videoThumbnailUrl || value.videoThumbnailUrl,
                    });
                }
            } catch { discardedResponses += 1; }
            finally { if (timer) clearTimeout(timer); }
        })();
        pending.add(task);
        void task.then(() => pending.delete(task), () => pending.delete(task));
    };
    const dispose = () => {
        disposed = true;
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('close', dispose);
        records.clear();
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('close', dispose);
    return {
        async read() { await Promise.all([...pending]); return records; },
        dispose,
        counts: () => ({ capturedResponses, discardedResponses, storedAds: records.size,
            withVideo: [...records.values()].filter((record) => Boolean(record.videoUrl || record.videoThumbnailUrl)).length }),
    };
}
