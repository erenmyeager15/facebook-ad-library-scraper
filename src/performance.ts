import type { PlaywrightCrawlingContext } from 'crawlee';
import { SearchEvidenceError } from './reporting.js';

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

export async function blockMediaDownloads(
    blockRequests: PlaywrightCrawlingContext['blockRequests'],
): Promise<void> {
    // Override Crawlee's defaults: they also block CSS, which our rendered-card
    // fallback needs for card geometry and computed background-image URLs.
    await blockRequests({ urlPatterns: [...BLOCKED_MEDIA_URL_PATTERNS] });
}

/** Let rendered previews finish before taking a DOM snapshot of initial cards. */
export async function waitForAdPreviews(page: PlaywrightCrawlingContext['page']): Promise<void> {
    try {
        const readiness = await page.waitForFunction(() => Array.from(document.images).every((image) => {
            const box = image.getBoundingClientRect();
            // The extractor can read rendered cards below the viewport too.
            // Checking only visible previews would still misclassify that batch.
            const renderedPreview = box.width >= 32 && box.height >= 32;
            return !renderedPreview || image.complete;
        }), undefined, { timeout: 5000, polling: 100 });
        await readiness.dispose();
    } catch {
        // Never silently save an image-only interpretation of a still-loading
        // video card. Raw browser errors are not included in this fixed reason.
        throw new SearchEvidenceError('preview_unready');
    }
}
