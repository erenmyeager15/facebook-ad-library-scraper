import type { Page } from 'playwright';
import { inspectSearchEvidence, SearchEvidenceError } from './reporting.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const consentSelectors = [
    'button[data-cookiebanner="accept_button"]',
    'button:has-text("Allow all cookies")',
    'button:has-text("Allow the use of cookies")',
    'button:has-text("Accept All")',
];

/** Warm-up belongs to a browser page, never to persistent request.userData. */
export function createPageWarmup() {
    const warmed = new WeakSet<Page>();
    return async (page: Page): Promise<boolean> => {
        if (warmed.has(page)) return true;
        try {
            const response = await page.goto('https://www.facebook.com/ads/library/', {
                waitUntil: 'domcontentloaded', timeout: 30_000,
            });
            if (response && response.status() >= 400) return false;
            for (const selector of consentSelectors) {
                const button = page.locator(selector).first();
                if (await button.isVisible().catch(() => false)) {
                    await button.click({ timeout: 3000 });
                    break;
                }
            }
            if (!isAdLibrary(page.url())) return false;
            warmed.add(page);
            return true;
        } catch {
            // An unsuccessful warm-up is not cached. The real navigation still
            // gets an attempt, but a fresh retry page always warms independently.
            return false;
        }
    };
}

const isAdLibrary = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && ['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(url.hostname)
            && /^\/ads\/library\/?$/.test(url.pathname);
    } catch { return false; }
};

export function scopeDiagnostic(loadedUrl: string, requestedUrl: string) {
    try {
        const loaded = new URL(loadedUrl);
        const requested = new URL(requestedUrl);
        const keys = new Set(['q', 'view_all_page_id', 'active_status', 'country', 'ad_type', 'category',
            'search_type', 'media_type', ...[...loaded.searchParams.keys(), ...requested.searchParams.keys()]
                .filter((key) => /^publisher_platforms(?:\[\d*\])?$/.test(key))]);
        return {
            loadedPage: isAdLibrary(loadedUrl) ? 'ad_library' : 'other',
            changedKeys: [...keys].filter((key) => JSON.stringify(loaded.searchParams.getAll(key))
                !== JSON.stringify(requested.searchParams.getAll(key))),
        };
    } catch { return { loadedPage: 'invalid', changedKeys: [] as string[] }; }
}

function isNavigationInterruption(error: unknown): boolean {
    return error instanceof Error && /execution context was destroyed|because (?:the page is|of a) navigat|frame was detached|target page, context or browser has been closed/i.test(error.message);
}

export function classifySearchError(error: unknown): SearchEvidenceError['reason'] {
    return error instanceof SearchEvidenceError ? error.reason
        : isNavigationInterruption(error) ? 'navigation_interrupted' : 'request_failed';
}

/** One exact-URL recovery per page, with strict scope checks before extraction. */
export function createSearchNavigation(dependencies: {
    wait?: (ms: number) => Promise<void>;
    onRecovery?: (diagnostic: ReturnType<typeof scopeDiagnostic>) => void;
} = {}) {
    const pause = dependencies.wait ?? wait;
    const recoveredPages = new WeakSet<Page>();
    return async (page: Page, requestedUrl: string): Promise<{ html: string; url: string }> => {
        if (!isAdLibrary(requestedUrl)) throw new SearchEvidenceError('search_scope_changed');
        let stableUrl: string | undefined;
        let mismatches = 0;
        for (let attempt = 0; attempt < 8; attempt++) {
            const before = page.url();
            let html: string;
            try { html = await page.content(); }
            catch (error) {
                if (!isNavigationInterruption(error)) throw new SearchEvidenceError('request_failed');
                stableUrl = undefined;
                await pause(250);
                continue;
            }
            const after = page.url();
            if (before !== after) {
                stableUrl = undefined;
                await pause(250);
                continue;
            }
            const evidence = inspectSearchEvidence(html, after, requestedUrl);
            if (evidence.kind === 'blocked' || evidence.reason === 'source_error') {
                throw new SearchEvidenceError(evidence.reason);
            }
            if (evidence.reason !== 'search_scope_changed') {
                if (stableUrl === after) return { html, url: after };
                stableUrl = after;
                mismatches = 0;
            } else {
                stableUrl = undefined;
                if (!isAdLibrary(after)) throw new SearchEvidenceError('search_scope_changed');
                mismatches += 1;
                if (mismatches >= 2) {
                    if (recoveredPages.has(page)) throw new SearchEvidenceError('search_scope_changed');
                    recoveredPages.add(page);
                    dependencies.onRecovery?.(scopeDiagnostic(after, requestedUrl));
                    try {
                        const response = await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                        if (response && response.status() >= 400) {
                            throw new SearchEvidenceError([401, 403, 429].includes(response.status()) ? 'blocked' : 'source_error');
                        }
                    } catch (error) {
                        if (error instanceof SearchEvidenceError) throw error;
                        throw new SearchEvidenceError('navigation_interrupted');
                    }
                    mismatches = 0;
                }
            }
            await pause(250);
        }
        throw new SearchEvidenceError('navigation_interrupted');
    };
}
