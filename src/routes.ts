import { Router, PlaywrightCrawlingContext } from 'crawlee';
import { log } from 'crawlee';
import { Actor } from 'apify';
import { wasPushedRecordSaved } from './billing.js';
import { AdRecord } from './types.js';

interface RawAdLink {
    text: string;
    href: string;
}

interface RawAdCandidate {
    adId: string;
    text: string;
    lines: string[];
    links: RawAdLink[];
    imageUrls: string[];
    videoUrls: string[];
    videoThumbnailUrls: string[];
}

const CTA_TEXTS = new Set([
    'apply now',
    'book now',
    'buy now',
    'call now',
    'contact us',
    'donate now',
    'download',
    'get offer',
    'get quote',
    'install now',
    'learn more',
    'listen now',
    'message page',
    'order now',
    'play game',
    'request time',
    'see menu',
    'shop now',
    'sign up',
    'subscribe',
    'use app',
    'watch more',
]);

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): number {
    return Math.floor(Math.random() * 2500) + 1500;
}

function normalizeText(value: string | null | undefined): string | null {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || null;
}

function normalizeMultiline(value: string): string[] {
    return value
        .split(/\r?\n/)
        .map((line) => normalizeText(line))
        .filter((line): line is string => Boolean(line));
}

function uniq(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function imageQualityScore(url: string): number {
    if (/s\d+x\d+/i.test(url)) {
        const match = url.match(/s(\d+)x(\d+)/i);
        if (match) return Number(match[1]) * Number(match[2]);
    }

    return 1_000_000;
}

export function extractAdId(url: string): string | null {
    const queryMatch = url.match(/[?&]id=(\d{5,})/);
    if (queryMatch) return queryMatch[1];

    const match = url.match(/\/(\d{5,})(?:[/?#]|$)/);
    return match ? match[1] : null;
}

function extractAdIdFromText(text: string): string | null {
    const match = text.match(/(?:Library\s+ID|ID):\s*(\d{5,})/i);
    return match ? match[1] : null;
}

export function normalizeFacebookUrl(href: string | null | undefined): string | null {
    if (!href) return null;

    let url = href.trim();
    if (!url || url.startsWith('javascript:') || url.startsWith('#')) return null;

    if (url.startsWith('/l.php?') || /^https?:\/\/([^/]+\.)?facebook\.com\/l\.php\?/i.test(url)) {
        const parsed = new URL(url, 'https://www.facebook.com');
        const target = parsed.searchParams.get('u');
        if (target) url = target;
    }

    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('/')) return `https://www.facebook.com${url}`;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;

    return `https://www.facebook.com/${url}`;
}

export function parsePageIdFromUrl(url: string | null): string | null {
    if (!url) return null;
    const pageMatch = url.match(/[?&](?:page_id|view_all_page_id)=(\d{5,})/);
    if (pageMatch) return pageMatch[1];

    if (/\/profile\.php/i.test(url)) {
        const profileMatch = url.match(/[?&]id=(\d{5,})/);
        if (profileMatch) return profileMatch[1];
    }

    return null;
}

function isFacebookUrl(url: string | null): boolean {
    return Boolean(url && /^https?:\/\/([^/]+\.)?facebook\.com\//i.test(url));
}

function isLikelyAdvertiserLink(link: RawAdLink): boolean {
    const text = normalizeText(link.text);
    const href = normalizeFacebookUrl(link.href);
    if (!text || !href) return false;

    const lowerText = text.toLowerCase();
    const lowerHref = href.toLowerCase();
    if (CTA_TEXTS.has(lowerText)) return false;
    if (lowerText.includes('see ad details') || lowerText.includes('ad library')) return false;
    if (lowerHref.includes('/ads/library') && !lowerHref.includes('view_all_page_id=')) return false;
    if (lowerHref.includes('/privacy') || lowerHref.includes('/help') || lowerHref.includes('/policies')) return false;

    return isFacebookUrl(href);
}

function isMetaLine(line: string): boolean {
    const lower = line.toLowerCase();
    return (
        /^(library\s+id|id):\s*\d+/.test(lower)
        || /^(active|inactive)$/.test(lower)
        || /^started\s+(running\s+)?/.test(lower)
        || /^ended\s+/.test(lower)
        || /^platforms?$/.test(lower)
        || /^(facebook|instagram|messenger|audience network)$/.test(lower)
        || lower === 'sponsored'
        || lower === 'ad'
        || lower === 'ads'
        || lower === 'open drop-down'
        || lower === 'close drop-down'
        || lower === 'more'
        || lower.includes('see ad details')
        || lower.includes('this ad has multiple versions')
        || lower.includes('shown on facebook')
        || lower.includes('paid for by')
    );
}

function isDomainLike(line: string): boolean {
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(line.trim());
}

function pickAdvertiserName(lines: string[], links: RawAdLink[]): string | null {
    const advertiserLink = links.find(isLikelyAdvertiserLink);
    const linkText = normalizeText(advertiserLink?.text);
    if (linkText) return linkText;

    return lines.find((line) => {
        const lower = line.toLowerCase();
        return line.length <= 100
            && !isMetaLine(line)
            && !CTA_TEXTS.has(lower)
            && !/^https?:\/\//i.test(line)
            && !/^\d+$/.test(line);
    }) ?? null;
}

function pickCtaText(links: RawAdLink[], lines: string[] = []): string | null {
    for (const link of links) {
        const text = normalizeText(link.text);
        if (text && CTA_TEXTS.has(text.toLowerCase())) return text;
    }

    for (const line of lines) {
        if (CTA_TEXTS.has(line.toLowerCase())) return line;
    }

    return null;
}

function pickDestinationUrl(links: RawAdLink[]): string | null {
    for (const link of links) {
        const href = normalizeFacebookUrl(link.href);
        if (href && !isFacebookUrl(href)) return href;
    }
    return null;
}

function pickHeadline(lines: string[], advertiserName: string | null, ctaText: string | null, links: RawAdLink[]): string | null {
    for (let i = 0; i < lines.length - 1; i++) {
        if (!isDomainLike(lines[i])) continue;

        const previewLine = lines.slice(i + 1).find((line) => {
            const lower = line.toLowerCase();
            return line.length >= 3
                && line.length <= 140
                && line !== advertiserName
                && line !== ctaText
                && !CTA_TEXTS.has(lower)
                && !isMetaLine(line)
                && !isDomainLike(line);
        });

        if (previewLine) return previewLine;
    }

    const externalLinkTexts = links
        .map((link) => ({ text: normalizeText(link.text), href: normalizeFacebookUrl(link.href) }))
        .filter((link): link is { text: string; href: string } => Boolean(link.text && link.href && !isFacebookUrl(link.href)))
        .map((link) => link.text)
        .filter((text) => {
            const lower = text.toLowerCase();
            return text.length >= 3
                && text.length <= 90
                && text !== advertiserName
                && text !== ctaText
                && !(advertiserName && lower.includes(advertiserName.toLowerCase()))
                && ![...CTA_TEXTS].some((cta) => lower.includes(cta))
                && !CTA_TEXTS.has(lower)
                && !isMetaLine(text);
        });
    const externalHeadline = externalLinkTexts.find((text) => !isDomainLike(text)) ?? externalLinkTexts[0];
    if (externalHeadline) return externalHeadline;

    return null;
}

function pickCreativeText(lines: string[], advertiserName: string | null, headline: string | null, ctaText: string | null): string | null {
    const sponsoredIndex = lines.findIndex((line) => line.toLowerCase() === 'sponsored');
    const scanLines = sponsoredIndex >= 0 ? lines.slice(sponsoredIndex + 1) : lines;
    const domainIndex = scanLines.findIndex(isDomainLike);
    const primaryLines = domainIndex > 0 ? scanLines.slice(0, domainIndex) : scanLines;
    const contentLines = primaryLines.filter((line) => {
        const lower = line.toLowerCase();
        return !isMetaLine(line)
            && line !== advertiserName
            && line !== ctaText
            && !CTA_TEXTS.has(lower)
            && !isDomainLike(line)
            && !/^https?:\/\//i.test(line);
    });

    if (contentLines.length) return normalizeText(contentLines.slice(0, 4).join('\n'));

    const fallbackLines = scanLines.filter((line) => {
        const lower = line.toLowerCase();
        return !isMetaLine(line)
            && line !== advertiserName
            && line !== headline
            && line !== ctaText
            && !CTA_TEXTS.has(lower)
            && !/^https?:\/\//i.test(line);
    });

    return normalizeText(fallbackLines.slice(0, 4).join('\n'));
}

function parseRange(text: string, pattern: RegExp): string | null {
    const match = text.match(pattern);
    return match ? normalizeText(match[1]) : null;
}

function debugKey(searchQuery: string): string {
    const safeQuery = searchQuery.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'search';
    return `DEBUG_AD_LIBRARY_${safeQuery}_${Date.now()}`;
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
    const rawCandidates = await page.evaluate((): RawAdCandidate[] => {
        const normalize = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? '';
        const linesFrom = (value: string): string[] => value
            .split(/\r?\n/)
            .map((line) => normalize(line))
            .filter(Boolean);
        const idRegex = /(?:Library\s+ID|ID):\s*(\d{5,})/i;
        const idRegexGlobal = /(?:Library\s+ID|ID):\s*\d{5,}/gi;
        const roots: Array<{ adId: string; root: HTMLElement }> = [];
        const seenIds = new Set<string>();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

        while (walker.nextNode() && roots.length < 250) {
            const nodeText = walker.currentNode.textContent ?? '';
            const match = nodeText.match(idRegex);
            if (!match || seenIds.has(match[1])) continue;

            let node = walker.currentNode.parentElement;
            let chosen: HTMLElement | null = null;
            let depth = 0;

            while (node && node !== document.body && depth < 12) {
                const text = normalize(node.innerText || node.textContent);
                const idCount = text.match(idRegexGlobal)?.length ?? 0;
                const rect = node.getBoundingClientRect();
                const hasUsefulChildren = Boolean(node.querySelector('a[href], img, video, [style*="background-image"]'));

                if (
                    idCount === 1
                    && text.length >= 60
                    && text.length <= 12000
                    && rect.width >= 240
                    && rect.height >= 80
                    && hasUsefulChildren
                ) {
                    chosen = node;
                }

                if (idCount > 1 || text.length > 12000) break;
                node = node.parentElement;
                depth++;
            }

            if (!chosen) {
                chosen = walker.currentNode.parentElement?.closest('[role="article"], div') as HTMLElement | null;
            }

            if (chosen) {
                seenIds.add(match[1]);
                roots.push({ adId: match[1], root: chosen });
            }
        }

        return roots.map(({ adId, root }) => {
            const text = root.innerText || root.textContent || '';
            const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).map((link) => ({
                text: normalize(link.innerText || link.textContent),
                href: link.href || link.getAttribute('href') || '',
            })).filter((link) => link.href);
            const imageUrls = Array.from(root.querySelectorAll<HTMLImageElement>('img')).map((img) => (
                img.currentSrc || img.src || img.getAttribute('src') || ''
            ));
            const backgroundImageUrls = Array.from(root.querySelectorAll<HTMLElement>('[style*="background-image"]'))
                .map((el) => {
                    const bg = el.style.backgroundImage || window.getComputedStyle(el).backgroundImage;
                    const match = bg.match(/url\(["']?(.+?)["']?\)/);
                    return match?.[1] ?? '';
                });
            const videoUrls = Array.from(root.querySelectorAll<HTMLVideoElement | HTMLSourceElement>('video[src], video source[src]'))
                .map((video) => video.getAttribute('src') || '');
            const videoThumbnailUrls = Array.from(root.querySelectorAll<HTMLVideoElement>('video[poster]'))
                .map((video) => video.poster || video.getAttribute('poster') || '');

            return {
                adId,
                text,
                lines: linesFrom(text),
                links,
                imageUrls: [...imageUrls, ...backgroundImageUrls].filter(Boolean),
                videoUrls: videoUrls.filter(Boolean),
                videoThumbnailUrls: videoThumbnailUrls.filter(Boolean),
            };
        });
    });

    log.info('Ad card candidates found', {
        searchQuery,
        candidates: rawCandidates.length,
    });

    if (!rawCandidates.length) {
        const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        log.warning('No ad cards found in rendered DOM', {
            searchQuery,
            bodySnippet: normalizeText(bodyText)?.slice(0, 500) ?? null,
        });

        await Actor.setValue(debugKey(searchQuery), await page.content(), { contentType: 'text/html' }).catch((error) => {
            log.warning('Failed to save debug HTML snapshot', { error: String(error) });
        });

        return [];
    }

    const records: AdRecord[] = [];

    for (const candidate of rawCandidates) {
        if (seenAdIds.has(candidate.adId)) continue;
        seenAdIds.add(candidate.adId);

        const links = candidate.links
            .map((link) => ({ text: normalizeText(link.text) ?? '', href: normalizeFacebookUrl(link.href) ?? '' }))
            .filter((link) => link.href);
        const lines = normalizeMultiline(candidate.text);
        const advertiserPageName = pickAdvertiserName(lines, links);
        const ctaButtonText = pickCtaText(links, lines);
        const adHeadline = pickHeadline(lines, advertiserPageName, ctaButtonText, links);
        const adCreativeText = pickCreativeText(lines, advertiserPageName, adHeadline, ctaButtonText);
        const destinationUrl = pickDestinationUrl(links);
        const adLibraryLink = links.find((link) => {
            const href = link.href.toLowerCase();
            return href.includes('/ads/library') && extractAdId(href) === candidate.adId;
        })?.href ?? `https://www.facebook.com/ads/library/?id=${candidate.adId}`;
        const advertiserLink = links.find(isLikelyAdvertiserLink);
        const advertiserPageUrl = advertiserLink ? normalizeFacebookUrl(advertiserLink.href) : null;
        const advertiserPageId = parsePageIdFromUrl(advertiserPageUrl)
            ?? parsePageIdFromUrl(adLibraryLink)
            ?? links.map((link) => parsePageIdFromUrl(link.href)).find(Boolean)
            ?? null;
        const imageUrls = uniq(candidate.imageUrls)
            .map((url) => normalizeFacebookUrl(url) ?? url)
            .filter((url) => !url.startsWith('data:') && !/emoji|static.xx.fbcdn.net\/rsrc/i.test(url))
            .sort((a, b) => imageQualityScore(b) - imageQualityScore(a))
            .slice(0, 10);
        // Creative images only: drop the advertiser avatar/logo and other tiny thumbnails
        // (e.g. sNNxNN where a dimension is < 200) so ad-type detection isn't skewed.
        const creativeImages = imageUrls.filter((url) => {
            const m = url.match(/s(\d+)x(\d+)/i);
            if (!m) return true;
            return Number(m[1]) >= 200 && Number(m[2]) >= 200;
        });
        const effectiveImages = creativeImages.length ? creativeImages : imageUrls;
        const videoUrl = candidate.videoUrls.map((url) => normalizeFacebookUrl(url) ?? url).find(Boolean) ?? null;
        const videoThumbnailUrl = candidate.videoThumbnailUrls
            .map((url) => normalizeFacebookUrl(url) ?? url)
            .find(Boolean) ?? null;

        let adType: string | null = 'text';
        if (videoUrl || videoThumbnailUrl) {
            adType = 'video';
        } else if (creativeImages.length > 1) {
            adType = 'carousel';
        } else if (effectiveImages.length >= 1) {
            adType = 'image';
        }

        const impressionsRange = parseRange(
            candidate.text,
            /([\d,.]+\s*[KMB]?\s*[-\u2013\u2014]\s*[\d,.]+\s*[KMB]?\s*(?:people saw this ad|impressions)?)/i
        );
        const spendRange = parseRange(
            candidate.text,
            /([$€£][\d,.]+\s*[KMB]?(?:\s*[-\u2013\u2014]\s*[$€£][\d,.]+\s*[KMB]?)?)\s*(?:USD|EUR|GBP)?/i
        );
        const adStartDate = parseRange(
            candidate.text,
            /Started\s+(?:running\s+)?(?:on|about)?\s*(.+?)(?:\s*[-\u2013\u2014]|\n|$)/i
        );
        const adEndDate = parseRange(candidate.text, /Ended\s+(.+?)(?:\s*[-\u2013\u2014]|\n|$)/i);
        const fundingEntity = parseRange(candidate.text, /(?:Funded by|Paid for by)\s+(.+?)(?:\n|$)/i);
        const targetingInfo = {
            age: parseRange(candidate.text, /Age\s+(\d+\s*[-\u2013\u2014]\s*\d+)/i),
            gender: parseRange(candidate.text, /(?:Shown to|Gender[:\s]+)\s*(Men|Women|All)/i),
            location: parseRange(candidate.text, /Locations?[:\s]+(.+?)(?:\n|$)/i),
        };

        const record = toNulls({
            adId: candidate.adId,
            advertiserPageName,
            advertiserPageId,
            advertiserPageUrl,
            adCreativeText,
            adHeadline,
            adDescription: null,
            ctaButtonText,
            destinationUrl,
            adType,
            imageUrl: effectiveImages[0] ?? null,
            imageUrls: effectiveImages,
            videoThumbnailUrl,
            videoUrl,
            adStartDate,
            adEndDate,
            impressionsRange,
            spendRange,
            countriesRunningIn: [],
            languages: [],
            platformsList: input.platforms,
            fundingEntity,
            paidForByText: fundingEntity,
            targetingInfo,
            adLibraryUrl: adLibraryLink,
            scrapedAt: new Date().toISOString(),
            searchQuery,
        }) as unknown as AdRecord;

        records.push(record);
    }

    return records;
}

async function extractAdCardsWithLocatorFallback(
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

    const previousHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    await page.evaluate(() => window.scrollBy(0, 2000));
    await sleep(randomDelay());
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await sleep(randomDelay());

    const nextHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => previousHeight);
    return nextHeight > previousHeight;
}

export function createRouter(
    seenAdIds: Set<string>,
    counters: {
        totalScraped: number;
        maxPerQuery: number;
        stopped: boolean;
        spendingLimitReached: boolean;
        saveErrorMessage: string | null;
    },
    input: { platforms: string[] }
) {
    const router = Router.create<PlaywrightCrawlingContext>();

    const searchHandler = async ({ request, page }: PlaywrightCrawlingContext): Promise<void> => {
        const keyword = request.userData.keyword as string;

        if (counters.stopped) {
            log.info('Scraping already stopped by the spending limit or a billing error; skipping', { keyword });
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

        let queryScraped = 0;
        let previousCount = queryScraped;
        let staleRounds = 0;
        const maxStaleRounds = 5;

        while (!counters.stopped && queryScraped < counters.maxPerQuery && staleRounds < maxStaleRounds) {
            const records = await extractAdCards(page, keyword, seenAdIds, input);
            log.info('Extracted records from current viewport', {
                keyword,
                records: records.length,
                totalScraped: counters.totalScraped,
            });

            for (const record of records) {
                if (counters.stopped || queryScraped >= counters.maxPerQuery) break;

                try {
                    // Push and charge together so records beyond the user's charge limit
                    // are not written to the dataset or scraped without revenue.
                    const chargeResult = await Actor.pushData(record, 'ad-scraped');
                    const recordWasSaved = wasPushedRecordSaved(chargeResult);
                    if (recordWasSaved) {
                        counters.totalScraped += 1;
                        queryScraped += 1;
                    }

                    if (chargeResult?.eventChargeLimitReached) {
                        log.info('Charge budget limit reached, stopping.', { totalScraped: counters.totalScraped });
                        counters.spendingLimitReached = true;
                        counters.stopped = true;
                        break;
                    }
                } catch (chargeErr) {
                    log.error('Unable to save and charge for ad; stopping to prevent unbilled work.', {
                        error: String(chargeErr),
                    });
                    counters.saveErrorMessage = `Unable to save and charge for Facebook ad: ${String(chargeErr)}`;
                    counters.stopped = true;
                    break;
                }

                if (counters.totalScraped % 50 === 0) {
                    log.info('Progress', { totalScraped: counters.totalScraped, keyword });
                }
            }

            if (queryScraped === previousCount) {
                staleRounds++;
            } else {
                staleRounds = 0;
            }
            previousCount = queryScraped;

            if (!counters.stopped && queryScraped < counters.maxPerQuery) {
                const scrolled = await scrollToLoadMore(page, queryScraped, counters.maxPerQuery);
                if (!scrolled && staleRounds > 0) {
                    break;
                }
            }
        }

        log.info('Finished page', { keyword, queryScraped, totalScraped: counters.totalScraped });
    };

    router.addHandler('search', searchHandler);
    router.addHandler('page', searchHandler);

    return router;
}
