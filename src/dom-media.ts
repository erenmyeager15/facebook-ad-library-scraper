import type { Page } from 'playwright';
import { inspectSearchEvidence, SearchEvidenceError } from './reporting.js';
import type { RecoveredAdMedia } from './routes.js';

const installed = new WeakSet<Page>();

/** Runs before public cards load. It observes DOM attributes, never requests data. */
function installObserver(): void {
    const key = '__apifyPublicAdDomMediaV1';
    const view = window as unknown as Record<string, unknown>;
    if (view[key]) return;
    const records = new Map<string, RecoveredAdMedia>();
    const pending = new Set<HTMLVideoElement>();
    const capacity = 500;
    let scope = '';
    const scopeKey = (): string => {
        const url = new URL(location.href);
        if (!['www.facebook.com', 'facebook.com'].includes(url.hostname)
            || !/^\/ads\/library\/?$/.test(url.pathname)
            || !(url.searchParams.get('q') || url.searchParams.get('view_all_page_id'))) return '';
        const keys = [...new Set(['q', 'view_all_page_id', 'active_status', 'country', 'ad_type',
            'category', 'search_type', 'media_type', ...[...url.searchParams.keys()]
                .filter(name => name.startsWith('publisher_platforms'))])].sort();
        return JSON.stringify(keys.map(name => [name, url.searchParams.getAll(name).sort()]));
    };
    const publicUrl = (value: string | null): string | null => {
        if (!value || value.length > 8192) return null;
        try { const url = new URL(value, location.href); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
        catch { return null; }
    };
    const state = { scopeUrl: '', records, observer: null as unknown as MutationObserver };
    const capture = (video: HTMLVideoElement): void => {
        if (!video.isConnected) { pending.delete(video); return; }
        const videoUrl = publicUrl(video.getAttribute('src'))
            || publicUrl(video.querySelector('source[src]')?.getAttribute('src') ?? null);
        const poster = publicUrl(video.getAttribute('poster'));
        if (!videoUrl && !poster) return;
        let node = video.parentElement;
        let id: string | null = null;
        for (let depth = 0; node && node !== document.body && depth < 24; depth += 1, node = node.parentElement) {
            const ids = [...(node.textContent ?? '').matchAll(/Library\s+ID:\s*(\d{5,30})(?!\d)/gi)]
                .map(match => match[1]);
            if (ids.length > 1) break;
            if (ids.length === 1) { id = ids[0]; break; }
        }
        if (!id) { if (pending.size < 128) pending.add(video); return; }
        pending.delete(video);
        const old = records.get(id);
        if (old) records.delete(id);
        else if (records.size >= capacity) records.delete(records.keys().next().value!);
        records.set(id, { adId: id, imageUrls: poster ? [poster] : old?.imageUrls ?? [],
            videoUrl: videoUrl || old?.videoUrl || null,
            videoThumbnailUrl: poster || old?.videoThumbnailUrl || null });
    };
    const observer = new MutationObserver(changes => {
        const current = scopeKey();
        if (current !== scope) { records.clear(); pending.clear(); scope = current; }
        state.scopeUrl = current ? location.href : '';
        if (!current) return;
        const videos = new Set(pending);
        const add = (node: Node): void => {
            if (!(node instanceof Element)) return;
            if (node instanceof HTMLVideoElement) videos.add(node);
            if (node instanceof HTMLSourceElement && node.parentElement instanceof HTMLVideoElement) videos.add(node.parentElement);
            for (const video of node.querySelectorAll('video')) {
                if (videos.size >= 250) break;
                videos.add(video);
            }
        };
        for (const change of changes) {
            // A body child-list mutation must not repeatedly consume the batch
            // on the first mounted players and starve newly paginated cards.
            for (const node of change.addedNodes) add(node);
            if (change.type === 'attributes' || change.target instanceof HTMLVideoElement
                || change.target instanceof HTMLSourceElement) add(change.target);
            if (videos.size >= 250) break;
        }
        for (const video of [...videos].slice(0, 250)) capture(video);
    });
    state.observer = observer;
    Object.defineProperty(view, key, { value: state, configurable: true });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'poster'] });
}

export async function installDomAdMediaCapture(page: Page): Promise<void> {
    if (installed.has(page)) return;
    await page.addInitScript(installObserver);
    installed.add(page);
}

/** Reuses media observed on this exact public search; it cannot create dataset rows. */
export async function readCapturedDomAdMedia(page: Page, requestedUrl: string): Promise<ReadonlyMap<string, RecoveredAdMedia>> {
    let captured: { scopeUrl: string; records: RecoveredAdMedia[] };
    try {
        captured = await page.evaluate(() => {
            const state = (window as unknown as Record<string, unknown>).__apifyPublicAdDomMediaV1 as
                { scopeUrl: string; records: Map<string, RecoveredAdMedia> } | undefined;
            return { scopeUrl: state?.scopeUrl ?? '', records: [...(state?.records.values() ?? [])].slice(-500) };
        });
    } catch { throw new SearchEvidenceError('preview_unready'); }
    if (!captured.scopeUrl) return new Map();
    if (inspectSearchEvidence('', page.url(), requestedUrl).reason !== 'unverified_zero'
        || inspectSearchEvidence('', captured.scopeUrl, requestedUrl).reason !== 'unverified_zero') return new Map();
    const valid = (value: string | null) => {
        if (!value || value.length > 8192) return null;
        try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; } catch { return null; }
    };
    return new Map(captured.records.filter(record => /^\d{5,30}$/.test(record.adId)).map(record => [record.adId,
        { adId: record.adId, imageUrls: record.imageUrls.map(valid).filter((value): value is string => Boolean(value)).slice(0, 10),
            videoUrl: valid(record.videoUrl), videoThumbnailUrl: valid(record.videoThumbnailUrl) }]));
}
