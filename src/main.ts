import { PlaywrightCrawler, log, LogLevel } from 'crawlee';
import { Actor } from 'apify';
import { ActorInput, DEFAULT_INPUT } from './types.js';
import { createRouter } from './routes.js';

const AD_LIBRARY_BASE = 'https://www.facebook.com/ads/library';

const CATEGORY_MAP: Record<string, string> = {
    all: 'ALL',
    issues_elections_politics: '2',
    housing: '3',
    employment: '4',
    credit: '5',
    political: '2',
};

function buildSearchUrl(keyword: string, input: Required<ActorInput>, pageId?: string): string {
    const params = new URLSearchParams();

    // active status
    if (input.adStatus === 'active') params.set('active_status', 'active');
    else if (input.adStatus === 'inactive') params.set('active_status', 'inactive');
    else params.set('active_status', 'all');

    params.set('ad_type', 'all');
    params.set('country', input.country && input.country !== 'ALL' ? input.country : 'ALL');

    if (pageId) {
        params.set('view_all_page_id', pageId);
    } else if (keyword) {
        params.set('q', keyword);
        params.set('search_type', 'keyword_unordered');
    }

    if (input.adCategory && input.adCategory !== 'all') {
        const catCode = CATEGORY_MAP[input.adCategory];
        if (catCode) params.set('category', catCode);
    }

    params.set('media_type', 'all');

    // NOTE: real Ad Library URL requires the trailing slash after /library/
    return `${AD_LIBRARY_BASE}/?${params.toString()}`;
}

Actor.main(async () => {
    const actorInput = (await Actor.getInput<ActorInput>()) ?? {};
    const input = {
        keywords: actorInput.keywords ?? DEFAULT_INPUT.keywords,
        pageIds: actorInput.pageIds ?? DEFAULT_INPUT.pageIds,
        advertiserNames: actorInput.advertiserNames ?? DEFAULT_INPUT.advertiserNames,
        country: actorInput.country ?? DEFAULT_INPUT.country,
        adCategory: actorInput.adCategory ?? DEFAULT_INPUT.adCategory,
        adStatus: actorInput.adStatus ?? DEFAULT_INPUT.adStatus,
        platforms: actorInput.platforms ?? DEFAULT_INPUT.platforms,
        maxResults: actorInput.maxResults ?? DEFAULT_INPUT.maxResults,
        proxyConfiguration: actorInput.proxyConfiguration,
    } as Required<ActorInput>;

    if (!input.keywords.length && !input.pageIds.length && !input.advertiserNames.length) {
        log.error('No search criteria provided. Provide at least one of: keywords, pageIds, or advertiserNames.');
        await Actor.exit({ exitCode: 1 });
        return;
    }

    log.setLevel(LogLevel.INFO);
    log.info('Starting Facebook Ad Library Scraper', {
        keywords: input.keywords,
        pageIds: input.pageIds,
        advertiserNames: input.advertiserNames,
        maxResults: input.maxResults,
        country: input.country,
        adCategory: input.adCategory,
        adStatus: input.adStatus,
    });

    // Facebook aggressively blocks datacenter IPs with 403. Default to residential
    // proxy when the user enabled Apify proxy but didn't pick a group.
    let effectiveProxy = input.proxyConfiguration;
    if (effectiveProxy?.useApifyProxy && !(effectiveProxy.apifyProxyGroups?.length)) {
        effectiveProxy = { ...effectiveProxy, apifyProxyGroups: ['RESIDENTIAL'] };
        log.info('Defaulting Apify proxy to RESIDENTIAL group (required for Facebook).');
    }

    const proxyConfiguration = effectiveProxy
        ? await Actor.createProxyConfiguration(effectiveProxy)
        : undefined;

    const urls: Array<{ url: string; label: string; userData: { keyword: string } }> = [];

    for (const keyword of input.keywords) {
        urls.push({
            url: buildSearchUrl(keyword, input),
            label: 'search',
            userData: { keyword },
        });
    }

    for (const pageId of input.pageIds) {
        urls.push({
            url: buildSearchUrl('', input, pageId),
            label: 'page',
            userData: { keyword: `page:${pageId}` },
        });
    }

    for (const name of input.advertiserNames) {
        urls.push({
            url: buildSearchUrl(name, input),
            label: 'search',
            userData: { keyword: name },
        });
    }

    log.info('Built search URLs', { count: urls.length });

    const seenAdIds = new Set<string>();
    const maxTotal = input.maxResults || 1000;
    const counters = { totalScraped: 0, maxTotal };

    const router = createRouter(seenAdIds, counters, { platforms: input.platforms });

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: urls.length * 30,
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 300,
        retryOnBlocked: true,
        maxRequestRetries: 5,
        sessionPoolOptions: {
            maxPoolSize: 20,
            sessionOptions: {
                maxUsageCount: 20,
            },
        },
        browserPoolOptions: {
            useFingerprints: true,
        },
        preNavigationHooks: [
            async ({ page, request }, gotoOptions) => {
                if (gotoOptions) {
                    gotoOptions.waitUntil = 'domcontentloaded';
                    gotoOptions.timeout = 90_000;
                }
                // Warm up the session: Facebook 403s cold requests to deep Ad Library
                // URLs. Visiting the Ad Library landing first establishes cookies in
                // this browser context so the subsequent query navigation is accepted.
                if (!request.userData.__warmed) {
                    request.userData.__warmed = true;
                    try {
                        await page.goto('https://www.facebook.com/ads/library/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 60_000,
                        });
                        const consentSelectors = [
                            'button[data-cookiebanner="accept_button"]',
                            'button:has-text("Allow all cookies")',
                            'button:has-text("Allow the use of cookies")',
                            'button:has-text("Accept All")',
                        ];
                        for (const sel of consentSelectors) {
                            const btn = page.locator(sel).first();
                            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                                await btn.click().catch(() => {});
                                log.info('Dismissed cookie consent popup (warm-up)');
                                break;
                            }
                        }
                        await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
                    } catch {
                        // Warm-up best effort; continue to the real navigation regardless.
                    }
                }
            },
        ],
        requestHandler: async (context) => {
            await router(context);
        },
        failedRequestHandler: async ({ request }, error) => {
            log.error('Request failed', {
                url: request.url,
                error: (error as Error).message,
                retryCount: request.retryCount,
            });
        },
    });

    await crawler.addRequests(urls);
    await crawler.run();

    log.info('Scraping complete', {
        totalScraped: counters.totalScraped,
        uniqueAds: seenAdIds.size,
    });

    await Actor.exit();
});
