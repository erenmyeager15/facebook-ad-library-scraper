export interface ActorInput {
    keywords?: string[];
    pageIds?: string[];
    advertiserNames?: string[];
    country?: string;
    adCategory?: 'all' | 'issues_elections_politics' | 'housing' | 'employment' | 'credit' | 'political';
    adStatus?: 'active' | 'inactive' | 'all';
    platforms?: string[];
    maxResults?: number;
    proxyConfiguration?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        apifyProxyCountry?: string;
    };
}

export interface AdRecord {
    adId: string | null;
    advertiserPageName: string | null;
    advertiserPageId: string | null;
    advertiserPageUrl: string | null;
    adCreativeText: string | null;
    adHeadline: string | null;
    adDescription: string | null;
    ctaButtonText: string | null;
    destinationUrl: string | null;
    adType: string | null;
    imageUrl: string | null;
    imageUrls: string[];
    videoThumbnailUrl: string | null;
    videoUrl: string | null;
    adStartDate: string | null;
    adEndDate: string | null;
    impressionsRange: string | null;
    spendRange: string | null;
    countriesRunningIn: string[];
    languages: string[];
    platformsList: string[];
    fundingEntity: string | null;
    paidForByText: string | null;
    targetingInfo: {
        age: string | null;
        gender: string | null;
        location: string | null;
    };
    adLibraryUrl: string | null;
    scrapedAt: string;
    searchQuery: string;
}

export const DEFAULT_INPUT: Required<Omit<ActorInput, 'proxyConfiguration'>> & { proxyConfiguration?: ActorInput['proxyConfiguration'] } = {
    keywords: [],
    pageIds: [],
    advertiserNames: [],
    country: 'US',
    adCategory: 'all',
    adStatus: 'active',
    platforms: ['facebook', 'instagram', 'messenger', 'audience_network'],
    maxResults: 10,
};
