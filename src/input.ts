import { ActorInput, DEFAULT_INPUT } from './types.js';

const AD_LIBRARY_BASE = 'https://www.facebook.com/ads/library';
const MAX_RESULTS = 1000;
const MAX_TERMS_PER_FIELD = 5;
const MAX_SEARCHES = 10;
const COUNTRY_CODE = /^[A-Z]{2}$/;

const CATEGORY_MAP: Record<string, string> = {
    all: 'ALL',
    issues_elections_politics: '2',
    housing: '3',
    employment: '4',
    credit: '5',
    political: '2',
};

const ALLOWED_CATEGORIES = new Set(Object.keys(CATEGORY_MAP));
const ALLOWED_STATUSES = new Set(['active', 'inactive', 'all']);
const ALLOWED_PLATFORMS = new Set(['facebook', 'instagram', 'messenger', 'audience_network']);

export interface NormalizedActorInput extends Omit<Required<ActorInput>, 'proxyConfiguration'> {
    proxyConfiguration?: ActorInput['proxyConfiguration'];
}

export function normalizeActorInput(actorInput: ActorInput | null | undefined): NormalizedActorInput {
    const input = actorInput ?? {};
    const keywords = uniqueStrings(input.keywords ?? DEFAULT_INPUT.keywords).slice(0, MAX_TERMS_PER_FIELD);
    const pageIds = uniqueStrings(input.pageIds ?? DEFAULT_INPUT.pageIds).slice(0, MAX_TERMS_PER_FIELD);
    const advertiserNames = uniqueStrings(input.advertiserNames ?? DEFAULT_INPUT.advertiserNames).slice(0, MAX_TERMS_PER_FIELD);
    const searchCount = keywords.length + pageIds.length + advertiserNames.length;

    if (searchCount === 0) {
        throw new Error('Provide at least one keyword, Page ID, or advertiser name.');
    }
    if (searchCount > MAX_SEARCHES) {
        throw new Error(`Too many Facebook Ad Library searches (${searchCount}). The maximum is ${MAX_SEARCHES} per run.`);
    }

    for (const pageId of pageIds) {
        if (!/^\d{5,}$/.test(pageId)) {
            throw new Error(`Page ID must be numeric: ${pageId}`);
        }
    }

    return {
        keywords,
        pageIds,
        advertiserNames,
        country: normalizeCountry(input.country),
        adCategory: normalizeEnum(input.adCategory, ALLOWED_CATEGORIES, DEFAULT_INPUT.adCategory),
        adStatus: normalizeEnum(input.adStatus, ALLOWED_STATUSES, DEFAULT_INPUT.adStatus),
        platforms: normalizePlatforms(input.platforms),
        maxResults: normalizeMaxResults(input.maxResults),
        proxyConfiguration: normalizeProxyConfiguration(input.proxyConfiguration),
    };
}

export function buildSearchUrl(keyword: string, input: NormalizedActorInput, pageId?: string): string {
    const params = new URLSearchParams();

    if (input.adStatus === 'active') params.set('active_status', 'active');
    else if (input.adStatus === 'inactive') params.set('active_status', 'inactive');
    else params.set('active_status', 'all');

    params.set('ad_type', 'all');
    params.set('country', input.country !== 'ALL' ? input.country : 'ALL');

    if (pageId) {
        params.set('view_all_page_id', pageId);
    } else if (keyword) {
        params.set('q', keyword);
        params.set('search_type', 'keyword_unordered');
    }

    if (input.adCategory !== 'all') {
        const catCode = CATEGORY_MAP[input.adCategory];
        if (catCode) params.set('category', catCode);
    }

    input.platforms.forEach((platform, index) => {
        params.set(`publisher_platforms[${index}]`, platform);
    });
    params.set('media_type', 'all');

    return `${AD_LIBRARY_BASE}/?${params.toString()}`;
}

function uniqueStrings(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    const normalized = values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
    return Array.from(new Set(normalized));
}

function normalizeCountry(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return DEFAULT_INPUT.country;
    const country = value.trim().toUpperCase();
    if (country === 'ALL') return country;
    if (!COUNTRY_CODE.test(country)) {
        throw new Error('Country must be ALL or a two-letter ISO country code, such as US, GB, or IN.');
    }
    return country;
}

function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const normalized = value.trim().toLowerCase();
    if (!allowed.has(normalized)) return fallback;
    return normalized as T;
}

function normalizePlatforms(values: unknown): string[] {
    const platforms = uniqueStrings(values ?? DEFAULT_INPUT.platforms)
        .map((platform) => platform.toLowerCase())
        .filter((platform) => ALLOWED_PLATFORMS.has(platform));
    return platforms.length ? platforms : DEFAULT_INPUT.platforms;
}

function normalizeMaxResults(value: unknown): number {
    if (value === null || value === undefined || value === '') return DEFAULT_INPUT.maxResults;
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error('Max results must be a number.');
    }
    return Math.max(1, Math.min(MAX_RESULTS, Math.floor(number)));
}

function normalizeProxyConfiguration(value: ActorInput['proxyConfiguration'] | undefined): ActorInput['proxyConfiguration'] {
    if (value === undefined) return DEFAULT_INPUT.proxyConfiguration;
    if (!value.useApifyProxy) return { ...value, useApifyProxy: false };
    if (value.apifyProxyGroups?.length) return value;
    return { ...value, useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
}
