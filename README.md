# Facebook Ad Library Scraper - Competitor Ads, Creatives & Spend

Scrape public ads from the Facebook Ad Library and turn them into structured datasets for competitor research, creative analysis, political ad monitoring, and brand tracking. Export results to JSON, CSV, Excel, or HTML, or pull them through the Apify API.

The Actor works with public Facebook Ad Library pages. It does not require a Facebook login, password, or private API key.

For a low-cost first run, use the default sample input: `Nike`, `US`, active ads, Facebook + Instagram platforms, `maxResults: 1`, and Residential proxy.

## What It Extracts

- Ad ID and direct Ad Library URL
- Advertiser page name, Page ID, and public page URL
- Primary ad text, headline, description, and call-to-action text
- Destination URL when visible
- Creative type: image, video, carousel, or text
- Primary image URL, image URLs, video thumbnail, and video URL when visible
- Start and end dates when visible
- Spend and impression ranges when Meta publicly discloses them
- Countries, languages, and platform list when visible
- Funding entity and paid-for-by text for eligible issue/political ads
- Public targeting summary when visible
- Search query and scrape timestamp

## Use Cases

- Competitor ad research and creative benchmarking
- Brand campaign monitoring across public Meta ads
- Political and issue-ad transparency research
- Spend and impression range analysis where Meta discloses those fields
- Tracking public messaging, calls to action, and campaign landing pages

## Pricing

| Event | Price | Notes |
| --- | ---: | --- |
| `apify-actor-start` | `$0.00005` per GB | Charged when the Actor starts. A 4 GB run charges 4 start events. |
| `ad-scraped` | `$0.001` per ad | Charged once for each clean ad record saved to the dataset. |

Example ad-event cost: 1,000 saved ads cost `$1.00`; 10,000 saved ads cost `$10.00`. Start events are tiny but still included in paid runs.

Failed, blocked, duplicate, or empty records are not charged as `ad-scraped` events. The Actor stops before doing more ad extraction when the user's maximum run cost is reached.

To control cost, start with one search term or one Page ID, one country, active ads, and `maxResults: 1`. Increase volume only after the sample output looks right. Residential proxy is recommended for Facebook reliability.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `keywords` | string array | `["Nike"]` | Search keywords. Up to 5 items. |
| `pageIds` | string array | `[]` | Numeric Facebook Page IDs. Up to 5 items. |
| `advertiserNames` | string array | `[]` | Advertiser or Page names. Up to 5 items. |
| `country` | string | `US` | Two-letter country code such as `US`, `GB`, `DE`, `IN`, or `ALL`. |
| `adCategory` | string | `all` | `all`, `issues_elections_politics`, `housing`, `employment`, `credit`, or `political`. |
| `adStatus` | string | `active` | `active`, `inactive`, or `all`. |
| `platforms` | string array | `["facebook", "instagram"]` | Meta platforms to include. |
| `maxResults` | integer | `1` | Maximum ads to save per search query, up to 1000. |
| `proxyConfiguration` | object | Residential | Apify Proxy settings. |

The Actor rejects runs with more than 10 total keyword, Page ID, and advertiser-name searches so accidental broad inputs do not create expensive or confusing jobs.

## Example Input

```json
{
  "keywords": ["Nike"],
  "pageIds": [],
  "advertiserNames": [],
  "country": "US",
  "adCategory": "all",
  "adStatus": "active",
  "platforms": ["facebook", "instagram"],
  "maxResults": 1,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Page ID search

```json
{
  "keywords": [],
  "pageIds": ["15087023444"],
  "advertiserNames": [],
  "country": "US",
  "adStatus": "active",
  "platforms": ["facebook", "instagram"],
  "maxResults": 10,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## How to Scrape the Facebook Ad Library

1. Enter one keyword, advertiser name, or numeric Page ID.
2. Choose a country and keep `adStatus` set to `active` for the first run.
3. Keep `maxResults` low until you inspect the dataset.
4. Run the Actor.
5. Export the dataset as JSON, CSV, Excel, or HTML, or use the API.

## Output Dataset

```json
{
  "adId": "1234567890123456789",
  "advertiserPageName": "Nike",
  "advertiserPageId": "15087023444",
  "advertiserPageUrl": "https://www.facebook.com/profile.php?id=15087023444",
  "adCreativeText": "New collection available now.",
  "adHeadline": "Shop Nike",
  "adDescription": null,
  "ctaButtonText": "Shop Now",
  "destinationUrl": "https://www.nike.com/new-releases",
  "adType": "image",
  "imageUrl": "https://scontent.xx.fbcdn.net/v/example.jpg",
  "imageUrls": ["https://scontent.xx.fbcdn.net/v/example.jpg"],
  "videoThumbnailUrl": null,
  "videoUrl": null,
  "adStartDate": "2026-06-10",
  "adEndDate": null,
  "impressionsRange": null,
  "spendRange": null,
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
  "scrapedAt": "2026-06-10T12:00:00.000Z",
  "searchQuery": "Nike"
}
```

Many commercial ads do not expose spend, impressions, funding, or targeting fields. Those fields are returned as `null` or empty arrays when Meta does not disclose them.

## API Example

```bash
curl -X POST "https://api.apify.com/v2/acts/fascinating_lentil~facebook-ad-library-scraper/runs?token=YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keywords":["Nike"],"country":"US","adStatus":"active","platforms":["facebook","instagram"],"maxResults":1,"proxyConfiguration":{"useApifyProxy":true,"apifyProxyGroups":["RESIDENTIAL"]}}'
```

```js
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });
const run = await client.actor('fascinating_lentil/facebook-ad-library-scraper').call({
  keywords: ['Nike'],
  country: 'US',
  adStatus: 'active',
  platforms: ['facebook', 'instagram'],
  maxResults: 1,
  proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(`Got ${items.length} public ad records`);
```

## How It Works

The Actor builds public Facebook Ad Library search URLs from keywords, advertiser names, or Page IDs, opens them in a Playwright browser, handles cookie consent, reads structured ad records from Meta's embedded public page payload when available, falls back to rendered ad cards, deduplicates by ad ID, normalizes fields, and writes clean records to the Apify dataset.

If no ads are saved, the run fails with a clear message instead of appearing successful with an empty dataset.

## Known Limits

- Meta can change the Ad Library layout, field names, or access behavior.
- Some fields are available only for issue, election, or political ads.
- Commercial ads often do not disclose spend or impression ranges.
- Very broad searches can return changing or personalized public result sets.
- This Actor is not affiliated with Meta, Facebook, Instagram, or the Facebook Ad Library.

## Responsible Use

This Actor is intended for lawful collection of publicly available ad-transparency information only. Users are responsible for ensuring their use complies with Meta's terms, robots.txt, applicable privacy laws, and local regulations.

Do not use this Actor to collect, store, sell, or misuse personal data without a lawful basis. The Actor author is not responsible for misuse by end users.

## License

Apache-2.0
