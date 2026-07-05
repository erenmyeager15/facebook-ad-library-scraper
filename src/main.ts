import { PlaywrightCrawler, log, LogLevel } from 'crawlee';
import { Actor } from 'apify';
import { ActorInput } from './types.js';
import { buildSearchUrl, normalizeActorInput } from './input.js';
import { createRouter } from './routes.js';

Actor.main(async () => {
    const actorInput = (await Actor.getInput<ActorInput>()) ?? {};
    const input = normalizeActorInput(actorInput);

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
    const maxPerQuery = input.maxResults;
    const counters = {
        totalScraped: 0,
        maxPerQuery,
        stopped: false,
        spendingLimitReached: false,
        saveErrorMessage: null as string | null,
    };

    const router = createRouter(seenAdIds, counters, { platforms: input.platforms });

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: urls.length * 30,
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 300,
        retryOnBlocked: true,
        maxRequestRetries: 3,
        maxSessionRotations: 3,
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

    if (counters.saveErrorMessage) {
        throw new Error(counters.saveErrorMessage);
    }

    if (counters.totalScraped === 0 && !counters.spendingLimitReached) {
        log.warning('No Facebook Ad Library ads were saved. The Actor will finish successfully because Meta can return no matches or block a proxy/session during automated checks. Try a broader keyword, Page ID, country, or status filter.', {
            keywords: input.keywords,
            pageIds: input.pageIds,
            advertiserNames: input.advertiserNames,
            country: input.country,
            adStatus: input.adStatus,
            adCategory: input.adCategory,
        });
    }

    await Actor.exit();
});
