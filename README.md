# Facebook Ad Library Scraper - Competitor Ads, Creatives & Spend

Scrape the public **Facebook Ad Library** in minutes. This Facebook Ad Library scraper extracts ad creatives, copy, headlines, CTAs, spend ranges, impressions, run dates, and targeting info from facebook.com/ads/library for any keyword, advertiser, or Page ID. Export to JSON, CSV, Excel, or HTML, or pull via the Apify API — no login and no API key required, because the Ad Library is a public ad transparency tool.

Built with Node.js 20, TypeScript, and the Apify SDK. It handles pagination, scrolling, and cookie consent automatically, deduplicates by ad ID, and uses Apify residential proxies with retries so runs stay reliable and repeatable.

## What It Extracts

- `adId` — unique Facebook ad identifier
- `advertiserPageName` — name of the advertiser's Facebook page
- `advertiserPageId` — Facebook Page ID
- `advertiserPageUrl` — direct link to the advertiser's page
- `adCreativeText` — primary ad body text
- `adHeadline` — ad headline
- `adDescription` — ad description text
- `ctaButtonText` — call-to-action button text
- `destinationUrl` — link the ad points to
- `adType` — image, video, carousel, or text
- `imageUrl` — primary image URL
- `imageUrls` — all image URLs
- `videoThumbnailUrl` — video thumbnail
- `videoUrl` — direct video URL
- `adStartDate` — when the ad started running
- `adEndDate` — when the ad stopped (if inactive)
- `impressionsRange` — viewership range (e.g. 10K-50K)
- `spendRange` — estimated spend in USD
- `countriesRunningIn` — target countries
- `languages` — ad languages
- `platformsList` — where the ad runs
- `fundingEntity` — funding entity (political ads)
- `paidForByText` — "Paid for by" disclosure
- `targetingInfo` — age, gender, location (if disclosed)
- `adLibraryUrl` — direct link to the ad in the library
- `searchQuery` — original search keyword
- `scrapedAt` — extraction timestamp

## Use Cases

1. **Competitor ad research** — discover which ads competitors are running, their messaging, and creative formats, then benchmark against your own.
2. **Creative intelligence** — analyze high-performing ad copy, headlines, CTAs, and image/video formats across your industry.
3. **Political ad monitoring** — track political advertising spend, funding entities, "Paid for by" disclosures, and targeting across elections.
4. **Spend and impressions benchmarking** — pull spend ranges and impression ranges to estimate competitor budgets and reach.
5. **Brand and trend tracking** — monitor how brands appear in the Ad Library over time and spot new campaigns as they launch.

## Pricing

This Actor uses Apify Pay Per Event pricing. You pay only for ad records successfully saved to the dataset — failed, blocked, or empty results are not billed.

| Event name | Price per event | 1,000 ads | 10,000 ads |
| --- | ---: | ---: | ---: |
| `ad-scraped` | $0.001 | $1.00 | $10.00 |

## Input

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `keywords` | array | no | `["Nike"]` | Search keywords to find ads. Searched in sequence. |
| `pageIds` | array | no | `[]` | Numeric Facebook Page IDs to scrape ads for directly. |
| `advertiserNames` | array | no | `[]` | Advertiser or Page names to search for. |
| `country` | string | no | `ALL` | ISO 3166-1 alpha-2 code (e.g. US, GB, DE) or ALL. |
| `adCategory` | string | no | `all` | One of all, issues_elections_politics, housing, employment, credit, political. |
| `adStatus` | string | no | `active` | One of active, inactive, all. |
| `platforms` | array | no | all four | facebook, instagram, messenger, audience_network. |
| `maxResults` | integer | no | `20` | Max ads per search query (0 = unlimited, up to 1000). |
| `proxyConfiguration` | object | no | Residential | Apify proxy settings. Residential recommended. |

## Example Input

```json
{
    "keywords": ["Nike"],
    "country": "US",
    "adStatus": "active",
    "maxResults": 50,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

## How to Scrape the Facebook Ad Library (Step by Step)

1. Click **Try for free** / **Run**.
2. Enter search keywords, advertiser names, or numeric Page IDs.
3. Optionally set a `country`, `adCategory`, `adStatus`, and `platforms` filter.
4. Set `maxResults` (start small, like 20, to test).
5. Run, then export the results as JSON, CSV, Excel, or HTML, or pull them via the Apify API.

## Sample Output

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
    "imageUrl": "https://scontent.xx.fbcdn.net/v/example.jpg",
    "imageUrls": ["https://scontent.xx.fbcdn.net/v/example.jpg"],
    "videoThumbnailUrl": null,
    "videoUrl": null,
    "adStartDate": "2024-01-15",
    "adEndDate": null,
    "impressionsRange": "10K-50K",
    "spendRange": "$1,000-$5,000",
    "countriesRunningIn": ["US"],
    "languages": ["en"],
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

## How It Works

1. Validates the input and builds Ad Library search URLs from your keywords, advertiser names, or Page IDs.
2. Navigates the public Ad Library, handling cookie consent, scrolling, and pagination automatically.
3. Extracts and cleans each ad's fields, falling back to `null` when optional data is not disclosed.
4. Deduplicates results by `adId`.
5. Charges `ad-scraped` only after a clean record is saved, then writes it to the Apify Dataset.

## Known Limits

- Many fields are conditional. `spendRange`, `impressionsRange`, `fundingEntity`, `paidForByText`, and `targetingInfo` are typically populated only for political/issue ads where Meta discloses them; commercial ads often return `null` for these.
- The Ad Library exposes up to roughly 1,000 ads per search, so `maxResults` is capped at 1000.
- Field availability and layout depend on what Meta makes public and can change if the Ad Library changes.

## Ethics & Legal

This Actor scrapes **public data only** from Facebook's Ad Library, a transparency tool Meta provides for public-interest research and ad transparency. No Facebook login or authentication is used and no personal data is collected. You are responsible for complying with Meta's terms, privacy laws, GDPR, and local regulations wherever you use the data.

## License

Apache-2.0. See `LICENSE`.
