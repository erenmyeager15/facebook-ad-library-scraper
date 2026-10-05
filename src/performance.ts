import type { PlaywrightCrawlingContext } from 'crawlee';
import { SearchEvidenceError } from './reporting.js';
import { scanDomAdCards } from './dom-cards.js';

// Keep documents, JavaScript, GraphQL/fetch requests, CSS, icons and previews.
// Initial cards can hydrate video elements only after a preview image loads.
// A missing first-batch data payload must not turn video ads into image-only rows.
// Use Chromium URL blocking rather than page.route(), which disables HTTP cache.
export const BLOCKED_MEDIA_URL_PATTERNS = [
    '*://video*.fbcdn.net/*',
    '*://*.fbcdn.net/*.woff*',
    '*://*.fbcdn.net/*.ttf*',
    '*://*.fbcdn.net/*.otf*',
] as const;

export const FACEBOOK_BROWSER_LIMITS = {
    maxConcurrency: 1,
    maxOpenPagesPerBrowser: 1,
} as const;

// An image load can precede player insertion or a source-data update. A
// bounded quiet window is needed before treating an unknown image-only DOM
// card as settled; explicit player placeholders remain pending separately.
export const PREVIEW_MEDIA_SETTLE_MS = 1000;

export async function blockMediaDownloads(
    blockRequests: PlaywrightCrawlingContext['blockRequests'],
): Promise<void> {
    // Override Crawlee's defaults: they also block CSS, which our rendered-card
    // fallback needs for card geometry and computed background-image URLs.
    await blockRequests({ urlPatterns: [...BLOCKED_MEDIA_URL_PATTERNS] });
}

export interface PreviewReadinessOptions {
    excludedAdIds?: string[];
    maxCandidates?: number;
}

export interface PreviewReadiness {
    candidateAdIds: string[];
    pendingAdIds: string[];
}

/** Await only the current batch's ad previews; unrelated images never gate it. */
export async function waitForAdPreviews(
    page: PlaywrightCrawlingContext['page'],
    options: PreviewReadinessOptions = {},
): Promise<PreviewReadiness> {
    try {
        const deadline = Date.now() + 5000;
        let settledBatch: string | null = null;
        let settledSince = 0;
        while (true) {
            const state = await page.evaluate(scanDomAdCards, {
                excludedAdIds: options.excludedAdIds ?? [],
                maxCandidates: options.maxCandidates ?? 25,
                inspectPreviewsOnly: true,
                // Chromium does not request distant lazy previews until asked.
                // Activate only this bounded, unsaved batch, keeping the viewport.
                activateLazy: true,
            });
            const batch = JSON.stringify([state.candidateAdIds, state.mediaStateKey]);
            if (state.pendingAdIds.length === 0) {
                // Card IDs alone can remain unchanged while delayed player
                // hydration changes the media shape. Require a quiet window.
                if (state.candidateAdIds.length === 0 || batch === settledBatch
                    && Date.now() - settledSince >= PREVIEW_MEDIA_SETTLE_MS) {
                    return { candidateAdIds: state.candidateAdIds, pendingAdIds: [] };
                }
                if (batch !== settledBatch) {
                    settledBatch = batch;
                    settledSince = Date.now();
                }
            } else {
                settledBatch = null;
            }
            if (Date.now() >= deadline) {
                return { candidateAdIds: state.candidateAdIds,
                    pendingAdIds: state.pendingAdIds.length ? state.pendingAdIds : state.candidateAdIds };
            }
            await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
        }
    } catch {
        // A lost page/document is retryable. Ordinary image timeouts instead
        // return pending IDs so ready siblings can still be saved accurately.
        throw new SearchEvidenceError('preview_unready');
    }
}
