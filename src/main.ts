import { PlaywrightCrawler, PlaywrightCrawlingContext, log, LogLevel } from 'crawlee';
import { Actor } from 'apify';
import { ActorInput } from './types.js';
import { buildSearchUrl, normalizeActorInput } from './input.js';
import { createRouter, SearchTarget } from './routes.js';
import { RunReporter, SearchEvidenceError } from './reporting.js';
import { blockMediaDownloads, FACEBOOK_BROWSER_LIMITS } from './performance.js';
import { AdMediaCollector, createAdMediaCollector } from './media.js';
import { classifySearchError, createPageWarmup, createSearchNavigation, isBadExitError } from './navigation.js';
import { installDomAdMediaCapture, readCapturedDomAdMedia } from './dom-media.js';

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

    const urls: Array<{ url: string; label: string; userData: { keyword: string; target: SearchTarget } }> = [];

    for (const keyword of input.keywords) {
        urls.push({
            url: buildSearchUrl(keyword, input),
            label: 'search',
            userData: { keyword, target: { kind: 'keyword', value: keyword } },
        });
    }

    for (const pageId of input.pageIds) {
        urls.push({
            url: buildSearchUrl('', input, pageId),
            label: 'page',
            userData: { keyword: `page:${pageId}`, target: { kind: 'page', value: pageId } },
        });
    }

    for (const name of input.advertiserNames) {
        urls.push({
            url: buildSearchUrl(name, input),
            label: 'search',
            userData: { keyword: name, target: { kind: 'advertiser', value: name } },
        });
    }

    log.info('Built search URLs', { count: urls.length });
    // Keyword and advertiser jobs may share a URL but use different predicates.
    // Explicit keys prevent the request queue from silently dropping a job.
    const requests = urls.map((request, index) => ({ ...request, uniqueKey: `facebook-search-${index}` }));
    const reporter = new RunReporter(requests.map((request) => request.uniqueKey));

    const seenAdIds = new Set<string>();
    const maxPerQuery = input.maxResults;
    const counters = {
        totalScraped: 0,
        maxPerQuery,
        stopped: false,
        spendingLimitReached: false,
        saveErrorMessage: null as string | null,
    };

    const pageMedia = new WeakMap<PlaywrightCrawlingContext['page'], AdMediaCollector>();
    const pageSearchUrls = new WeakMap<PlaywrightCrawlingContext['page'], string>();
    const warmPage = createPageWarmup();
    const readSearch = createSearchNavigation({
        onRecovery: (diagnostic) => log.warning('Restoring the exact requested search after a scope reset', diagnostic),
    });
    const lastSearchReason = new Map<string, SearchEvidenceError['reason']>();
    const router = createRouter(seenAdIds, counters, {
        platforms: input.platforms,
        adStatus: input.adStatus,
    }, reporter, {
        readMedia: async (page) => {
            const media = new Map(await pageMedia.get(page)?.read() ?? []);
            const expected = pageSearchUrls.get(page);
            const domMedia = expected ? await readCapturedDomAdMedia(page, expected) : new Map();
            log.info('Public DOM video metadata available', {
                observedAds: domMedia.size,
                completeVideos: [...domMedia.values()].filter(value => value.videoUrl && value.videoThumbnailUrl).length,
            });
            for (const [id, value] of domMedia) {
                const old = media.get(id);
                media.set(id, { adId: id, imageUrls: old?.imageUrls.length ? old.imageUrls : value.imageUrls,
                    videoUrl: old?.videoUrl || value.videoUrl, videoThumbnailUrl: old?.videoThumbnailUrl || value.videoThumbnailUrl });
            }
            return media;
        },
        readSearch,
    });

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: FACEBOOK_BROWSER_LIMITS.maxConcurrency,
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
            maxOpenPagesPerBrowser: FACEBOOK_BROWSER_LIMITS.maxOpenPagesPerBrowser,
        },
        preNavigationHooks: [
            async ({ page, request, blockRequests }, gotoOptions) => {
                // Apply before the landing-page warm-up as well as the search.
                // Keep cache, CSS and source data requests working; only skip
                // video/font binaries, retaining previews needed for hydration.
                await blockMediaDownloads(blockRequests);
                await installDomAdMediaCapture(page);
                pageSearchUrls.set(page, request.url);
                pageMedia.get(page)?.dispose();
                pageMedia.set(page, createAdMediaCollector(page, request.url, maxPerQuery));
                if (gotoOptions) {
                    gotoOptions.waitUntil = 'domcontentloaded';
                    gotoOptions.timeout = 90_000;
                }
                // Retries open fresh pages. A flag on persistent request.userData
                // must not suppress warming that new browser page/context.
                await warmPage(page);
            },
        ],
        postNavigationHooks: [async ({ page, request, response }) => {
            try {
                if (response && response.status() >= 400) {
                    throw new SearchEvidenceError([401, 403, 429].includes(response.status()) ? 'blocked' : 'source_error');
                }
                // Settle before Crawlee's blocked-page selectors run; navigation
                // must not leave them evaluating a destroyed execution context.
                await readSearch(page, request.url);
            } catch (error) {
                if (error instanceof SearchEvidenceError) lastSearchReason.set(request.uniqueKey, error.reason);
                throw error;
            }
        }],
        requestHandler: async (context) => {
            try {
                await router(context);
                lastSearchReason.delete(context.request.uniqueKey);
                const media = pageMedia.get(context.page)?.counts();
                if (media) log.info('Public ad media recovery counters', media);
            } catch (error) {
                if (error instanceof SearchEvidenceError) lastSearchReason.set(context.request.uniqueKey, error.reason);
                throw error;
            }
        },
        errorHandler: async ({ session, request }, error) => {
            // Retire the session (and with it the browser and proxy exit) on network/TLS
            // failures so the next attempt gets a fresh residential IP immediately.
            if (session && isBadExitError(error)) {
                session.retire();
                log.warning('Rotating to a fresh proxy session after a network-level navigation failure.', {
                    jobId: request.uniqueKey,
                    retryCount: request.retryCount,
                });
            }
        },
        failedRequestHandler: async ({ request }, error) => {
            const reason = classifySearchError(error);
            reporter.finish(request.uniqueKey, 'failed', reason, request.retryCount);
            log.error('Facebook search failed after recovery attempts.', {
                jobId: request.uniqueKey,
                reason,
                earlierSearchReason: lastSearchReason.get(request.uniqueKey) ?? null,
                retryCount: request.retryCount,
            });
        },
    });

    let fatalReason: 'save_error' | 'crawl_error' | undefined;
    try {
        await crawler.addRequests(requests);
        await crawler.run();
    } catch {
        fatalReason = 'crawl_error';
        log.error('Facebook crawl stopped unexpectedly; preserving coverage counters.');
    }
    if (counters.saveErrorMessage) fatalReason = 'save_error';
    const summary = {
        ...reporter.summary({ spendingLimitReached: counters.spendingLimitReached, fatalReason }),
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('FACEBOOK-RUN-SUMMARY', summary);

    log.info('Scraping complete', {
        totalScraped: counters.totalScraped,
        outcome: summary.outcome,
        failedSearches: summary.failedSearches,
        limitedSearches: summary.limitedSearches,
    });

    if (fatalReason || summary.outcome === 'failed') {
        throw new Error(`Facebook search failed (${fatalReason ?? 'unverified_or_failed_search'}). See FACEBOOK-RUN-SUMMARY for coverage counters.`);
    }
    if (summary.outcome === 'partial' || summary.outcome === 'limited') {
        log.warning('Facebook coverage is incomplete. Inspect FACEBOOK-RUN-SUMMARY before comparing runs or assuming no matches.');
    }

    await Actor.exit();
});
