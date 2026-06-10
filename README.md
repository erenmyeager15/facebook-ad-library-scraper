# Facebook Ad Library Scraper

## Extract Competitor Ads & Creatives

**Scrape ads from the public Facebook Ad Library in seconds.** This Apify Actor extracts ad creatives, text, headlines, spend ranges, impressions, targeting info, and more from facebook.com/ads/library — the world's largest public ad transparency tool.

### What It Does

Enter search keywords, advertiser names, or Facebook Page IDs, and this Actor will:

- Scrape up to **1,000 ads per search** in a single run
- Extract **25+ data fields** per ad including creatives, copy, spend, and targeting
- Handle pagination, scrolling, and cookie consent automatically
- Deduplicate results by ad ID
- Save structured JSON to the Apify Dataset

### Use Cases

1. **Competitor Ad Research** — Discover what ads your competitors are running, their messaging strategy, and creative formats
2. **Political Ad Monitoring** — Track political advertising spend, messaging, and targeting across elections
3. **Creative Intelligence** — Analyze high-performing ad copy, headlines, CTAs, and creative formats in your industry
4. **Marketing Analysis** — Benchmark your ad spend and impressions against industry competitors
5. **Brand Tracking** — Monitor how your brand and competitors appear in the Ad Library over time

### Data Fields Extracted

| Field | Description |
|-------|-------------|
| `adId` | Unique Facebook ad identifier |
| `advertiserPageName` | Name of the advertiser's Facebook page |
| `advertiserPageId` | Facebook Page ID |
| `advertiserPageUrl` | Direct link to advertiser's page |
| `adCreativeText` | Primary ad body text |
| `adHeadline` | Ad headline |
| `adDescription` | Ad description text |
| `ctaButtonText` | Call-to-action button text |
| `destinationUrl` | Link the ad points to |
| `adType` | Image, video, carousel, or text |
| `imageUrl` | Primary image URL |
| `imageUrls` | Array of all image URLs |
| `videoThumbnailUrl` | Video thumbnail |
| `videoUrl` | Direct video URL |
| `adStartDate` | When the ad started running |
| `adEndDate` | When the ad stopped (if inactive) |
| `impressionsRange` | Viewership range (e.g. 1K-5K) |
| `spendRange` | Estimated spend in USD |
| `countriesRunningIn` | Target countries |
| `languages` | Ad languages |
| `platformsList` | Where the ad runs |
| `fundingEntity` | Funding entity (political ads) |
| `paidForByText` | "Paid for by" disclosure |
| `targetingInfo` | Age, gender, location (if disclosed) |
| `adLibraryUrl` | Direct link to ad in library |
| `scrapedAt` | Timestamp of extraction |
| `searchQuery` | Original search keyword |

### Sample Output

```json
{
    "adId": "1234567890123456789",
    "advertiserPageName": "Nike",
    "advertiserPageId": "150849945690582",
    "advertiserPageUrl": "https://www.facebook.com/profile.php?id=150849945690582",
    "adCreativeText": "Just Do It. New collection available now.",
    "adHeadline": "Shop Now",
    "adDescription": "Explore the latest Nike styles",
    "ctaButtonText": "Shop Now",
    "destinationUrl": "https://www.nike.com/new-releases",
    "adType": "image",
    "imageUrl": "https://scontent.xx.fbcdn.net/...",
    "imageUrls": ["https://scontent.xx.fbcdn.net/..."],
    "videoThumbnailUrl": null,
    "videoUrl": null,
    "adStartDate": "2024-01-15",
    "adEndDate": null,
    "impressionsRange": "10K-50K",
    "spendRange": "$1,000-$5,000",
    "countriesRunningIn": [],
    "languages": [],
    "platformsList": ["facebook", "instagram"],
    "fundingEntity": null,
    "paidForByText": null,
    "targetingInfo": {
        "age": null,
        "gender": null,
        "location": null
    },
    "adLibraryUrl": "https://www.facebook.com/ads/library/?id=1234567890123456789",
    "scrapedAt": "2024-06-10T12:00:00.000Z",
    "searchQuery": "Nike"
}
```

### Pricing

| Metric | Cost |
|--------|------|
| **Per ad scraped** | $0.002 |
| **100 ads** | $0.20 |
| **1,000 ads** | $2.00 |
| **10,000 ads** | $20.00 |

Pay-per-use pricing via Apify's Pay Per Event system. Only charged for successfully extracted ads.

### Input Options

- **keywords** — Search terms to find ads
- **pageIds** — Facebook Page IDs to scrape directly
- **advertiserNames** — Advertiser or page names to search
- **country** — ISO country code filter (e.g. US, GB, DE)
- **adCategory** — all, political, housing, employment, credit
- **adStatus** — active, inactive, or all
- **platforms** — facebook, instagram, messenger, audience_network
- **maxResults** — Max ads per search (up to 1,000)

### Ethics & Legal

This Actor scrapes **public data only** from Facebook's Ad Library, a transparency tool designed for public access. No Facebook login is required. The Ad Library is explicitly provided by Meta for public interest research and ad transparency.

- No personal data is collected
- No authentication or login is used
- All data is publicly available at facebook.com/ads/library
- Complies with Meta's terms for Ad Library data access

### Support

- Apify documentation: https://docs.apify.com
- Facebook Ad Library: https://www.facebook.com/ads/library
