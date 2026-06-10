import { Router, PlaywrightCrawlingContext } from 'crawlee';
import { Dataset, log } from 'crawlee';
import { Actor } from 'apify';
import { AdRecord } from './types.js';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): number {
    return Math.floor(Math.random() * 2500) + 1500;
}

function extractAdId(url: string): string | null {
    const match = url.match(/\/(\d{10,})/);
    return match ? match[1] : null;
}

function extractAdIdFromText(text: string): string | null {
    const match = text.match(/ID:\s*(\d+)/);
    return match ? match[1] : null;
}

function toNulls<T extends Record<string, unknown>>(obj: T): T {
    const result = { ...obj } as Record<string, unknown>;
    for (const key of Object.keys(result)) {
        if (result[key] === undefined || result[key] === '') {
            result[key] = null;
        }
    }
    return result as T;
}

async function dismissCookieConsent(page: PlaywrightCrawlingContext['page']): Promise<void> {
    try {
        const selectors = [
            'button[data-cookiebanner="accept_button"]',
            'button:has-text("Allow all cookies")',
            'button:has-text("Allow the use of cookies")',
            'button:has-text("Accept All")',
            'button:has-text("Accept Cookies")',
            '[data-testid="cookie-policy-manage-dialog-accept-button"]',
        ];
        for (const selector of selectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click();
                log.info('Dismissed cookie consent popup');
                await sleep(1000);
                return;
            }
        }
    } catch {
        // Cookie popup not present
    }
}

async function extractAdCards(
    page: PlaywrightCrawlingContext['page'],
    searchQuery: string,
    seenAdIds: Set<string>,
    input: { platforms: string[] }
): Promise<AdRecord[]> {
    const records: AdRecord[] = [];

    const cards = page.locator(
        '[role="article"], [class*="_7jvw"], [class*="x1dr75xp"], [class*="xrvj5dj"]'
    );
    const cardCount = await cards.count().catch(() => 0);

    for (let i = 0; i < cardCount; i++) {
        try {
            const card = cards.nth(i);

            const adLink = await card
                .locator('a[href*="/ads/library/?id="], a[href*="/ads/library/?page_id="]')
                .first()
                .getAttribute('href')
                .catch(() => null);

            let adId = adLink ? extractAdId(adLink) : null;

            if (!adId) {
                const idContainer = card.locator(
                    '[class*="x8t9es0"], [class*="xw3q929"], [class*="x1lliihq"]'
                );
                const idCount = await idContainer.count();
                for (let k = 0; k < idCount; k++) {
                    const text = await idContainer.nth(k).textContent().catch(() => '');
                    if (text) {
                        const found = extractAdIdFromText(text);
                        if (found) {
                            adId = found;
                            break;
                        }
                    }
                }
            }

            if (!adId) {
                adId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`;
            }

            if (seenAdIds.has(adId)) continue;
            seenAdIds.add(adId);

            const advertiserName = await card
                .locator('a[href*="/library/?page_id="] span, [class*="x1heor9g"] a, a[href*="profile.php"] span')
                .first()
                .textContent()
                .catch(() => null);

            const pageIdMatch = adLink?.match(/page_id=(\d+)/);
            const advertiserPageId = pageIdMatch ? pageIdMatch[1] : null;

            let advertiserPageUrl = null;
            if (advertiserPageId) {
                advertiserPageUrl = `https://www.facebook.com/profile.php?id=${advertiserPageId}`;
            } else {
                const pageLink = await card
                    .locator('a[href*="facebook.com/"], a[href*="profile.php"]')
                    .first()
                    .getAttribute('href')
                    .catch(() => null);
                if (pageLink) {
                    advertiserPageUrl = pageLink.startsWith('http')
                        ? pageLink
                        : `https://www.facebook.com${pageLink}`;
                }
            }

            const creativeText = await card
                .locator('[class*="x1iorvi4"], [class*="xjkvuw6"], [data-testid="ad-body"]')
                .first()
                .textContent()
                .catch(() => null);

            const headline = await card
                .locator('[class*="x1gslohp"], [class*="x1xqt6ti"], [class*="x1lliihq"] strong')
                .first()
                .textContent()
                .catch(() => null);

            const description = await card
                .locator('[class*="x1lku1ps"], [class*="xz9dl7a"]')
                .first()
                .textContent()
                .catch(() => null);

            const ctaButton = await card
                .locator('a[class*="x1emux4y"], [class*="x1lliihq"] a[href]:not([href*="facebook.com"])')
                .first()
                .textContent()
                .catch(() => null);

            const destinationUrl = await card
                .locator('a[class*="x1emux4y"], [class*="x1lliihq"] a[href]:not([href*="facebook.com"])')
                .first()
                .getAttribute('href')
                .catch(() => null);

            const imageUrls: string[] = [];
            const images = card.locator('img[src*="scontent"], img[src*="fbcdn"], img[src*="external"]');
            const imgCount = await images.count();
            for (let j = 0; j < Math.min(imgCount, 10); j++) {
                const src = await images.nth(j).getAttribute('src').catch(() => null);
                if (src && !src.includes('emoji') && !src.includes('icon')) {
                    imageUrls.push(src);
                }
            }

            const videoThumbnail = await card
                .locator('video[poster], [role="img"][style*="background-image"]')
                .first()
                .getAttribute('poster')
                .catch(() => null);

            const videoUrl = await card
                .locator('video source[src], video[src]')
                .first()
                .getAttribute('src')
                .catch(() => null);

            let adType: string | null = null;
            if (videoUrl || videoThumbnail) {
                adType = 'video';
            } else if (imageUrls.length > 1) {
                adType = 'carousel';
            } else if (imageUrls.length === 1) {
                adType = 'image';
            } else {
                adType = 'text';
            }

            let impressionsRange: string | null = null;
            let spendRange: string | null = null;
            let adStartDate: string | null = null;
            let adEndDate: string | null = null;
            let fundingEntity: string | null = null;

            const infoBlocks = card.locator('[class*="x1lliihq"], [class*="x8t9es0"]');
            const infoCount = await infoBlocks.count();
            for (let k = 0; k < infoCount; k++) {
                const text = await infoBlocks.nth(k).textContent().catch(() => '');
                if (!text) continue;

                if (!impressionsRange) {
                    const impMatch = text.match(
                        /([\d,.]+[KMB]?\s*[-–]\s*[\d,.]+[KMB]?\s*(?:people saw this ad)?)/i
                    );
                    if (impMatch) impressionsRange = impMatch[1].trim();
                }

                if (!spendRange) {
                    const spendMatch = text.match(/(\$[\d,.]+[KMB]?(?:\s*[-–]\s*\$[\d,.]+[KMB]?)?)\s*(?:USD)?/i);
                    if (spendMatch) spendRange = spendMatch[1].trim();
                }

                if (!adStartDate) {
                    const startMatch = text.match(
                        /(?:Started (?:running )?(?:on |about )?)(.+?)(?:\s*[-–]|$)/i
                    );
                    if (startMatch) adStartDate = startMatch[1].trim();
                }

                if (!adEndDate) {
                    const endMatch = text.match(/(?:Ended\s+)(.+?)(?:\s*[-–]|$)/i);
                    if (endMatch) adEndDate = endMatch[1].trim();
                }

                if (!fundingEntity) {
                    const fundMatch = text.match(
                        /(?:Funded by|Paid for by)\s+(.+)/i
                    );
                    if (fundMatch) fundingEntity = fundMatch[1].trim();
                }
            }

            const countriesRunningIn: string[] = [];
            const languages: string[] = [];
            const targetingInfo: { age: string | null; gender: string | null; location: string | null } = { age: null, gender: null, location: null };

            const targetingBlock = card.locator('[class*="x1lliihq"]');
            const tCount = await targetingBlock.count();
            for (let k = 0; k < tCount; k++) {
                const text = await targetingBlock.nth(k).textContent().catch(() => '');
                if (!text) continue;

                const ageMatch = text.match(/(?:Age\s+)(\d+[\s–-]+\d+)/i);
                if (ageMatch) targetingInfo.age = ageMatch[1];

                const genderMatch = text.match(/(?:Shown to|Gender[:\s]+)\s*(Men|Women|All)/i);
                if (genderMatch) targetingInfo.gender = genderMatch[1];

                const locMatch = text.match(/(?:Locations?[:\s]+)(.+)/i);
                if (locMatch) targetingInfo.location = locMatch[1].trim();
            }

            const adLibraryUrl = adLink
                ? `https://www.facebook.com${adLink.startsWith('/') ? '' : '/'}${adLink}`
                : null;

            const record = toNulls({
                adId,
                advertiserPageName: advertiserName,
                advertiserPageId,
                advertiserPageUrl,
                adCreativeText: creativeText,
                adHeadline: headline,
                adDescription: description,
                ctaButtonText: ctaButton,
                destinationUrl,
                adType,
                imageUrl: imageUrls[0] ?? null,
                imageUrls,
                videoThumbnailUrl: videoThumbnail,
                videoUrl,
                adStartDate,
                adEndDate,
                impressionsRange,
                spendRange,
                countriesRunningIn,
                languages,
                platformsList: input.platforms,
                fundingEntity,
                paidForByText: fundingEntity,
                targetingInfo,
                adLibraryUrl,
                scrapedAt: new Date().toISOString(),
                searchQuery,
            }) as unknown as AdRecord;

            records.push(record);
        } catch (cardErr) {
            log.warning('Error extracting ad card', { error: String(cardErr) });
        }
    }

    return records;
}

async function scrollToLoadMore(
    page: PlaywrightCrawlingContext['page'],
    currentCount: number,
    maxResults: number
): Promise<boolean> {
    if (currentCount >= maxResults) return false;

    const seeMoreBtn = page.locator(
        'button:has-text("See more"), [role="button"]:has-text("See more"), button:has-text("See More"), button:has-text("Show more"), button:has-text("Load more"), button:has-text("View more")'
    ).first();

    if (await seeMoreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await seeMoreBtn.click().catch(() => {});
        await sleep(randomDelay());
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await sleep(randomDelay());
        return true;
    }

    await page.evaluate(() => window.scrollBy(0, 2000));
    await sleep(randomDelay());
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await sleep(randomDelay());

    return false;
}

export function createRouter(
    seenAdIds: Set<string>,
    counters: { totalScraped: number; maxTotal: number },
    input: { platforms: string[] }
) {
    const router = Router.create<PlaywrightCrawlingContext>();

    const searchHandler = async ({ request, page }: PlaywrightCrawlingContext): Promise<void> => {
        const keyword = request.userData.keyword as string;

        if (counters.totalScraped >= counters.maxTotal) {
            log.info('Max results reached, skipping', { keyword });
            return;
        }

        log.info('Processing search page', {
            keyword,
            url: request.url,
            currentCount: counters.totalScraped,
        });

        await dismissCookieConsent(page);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await sleep(randomDelay());

        let previousCount = counters.totalScraped;
        let staleRounds = 0;
        const maxStaleRounds = 5;

        while (counters.totalScraped < counters.maxTotal && staleRounds < maxStaleRounds) {
            const records = await extractAdCards(page, keyword, seenAdIds, input);

            for (const record of records) {
                if (counters.totalScraped >= counters.maxTotal) break;

                await Dataset.pushData(record);
                counters.totalScraped++;

                try {
                    const chargeResult = await Actor.charge({ eventName: 'ad-scraped' });
                    if (chargeResult?.eventChargeLimitReached) {
                        log.info('Charge budget limit reached, stopping.', { totalScraped: counters.totalScraped });
                        counters.totalScraped = counters.maxTotal;
                        break;
                    }
                } catch (chargeErr) {
                    log.warning('PPE charge failed', { error: String(chargeErr) });
                }

                if (counters.totalScraped % 50 === 0) {
                    log.info('Progress', { totalScraped: counters.totalScraped, keyword });
                }
            }

            if (counters.totalScraped === previousCount) {
                staleRounds++;
            } else {
                staleRounds = 0;
            }
            previousCount = counters.totalScraped;

            if (counters.totalScraped < counters.maxTotal) {
                const scrolled = await scrollToLoadMore(page, counters.totalScraped, counters.maxTotal);
                if (!scrolled && staleRounds > 0) {
                    break;
                }
            }
        }

        log.info('Finished page', { keyword, scraped: counters.totalScraped });
    };

    router.addHandler('search', searchHandler);
    router.addHandler('page', searchHandler);

    return router;
}
