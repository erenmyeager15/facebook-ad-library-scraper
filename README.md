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
- Countries when disclosed; platform list from source evidence when available, otherwise requested-filter fallback
- `languages` is currently an empty array; language extraction is not implemented
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

The live pricing model is pay-per-event **plus Apify platform usage paid separately by the user**. The ad-event rate is not an all-in run price. The rates below reflect the active pricing checked on 30 September 2026; check the Store pricing panel before running.

| Event | Price | Notes |
| --- | ---: | --- |
| `apify-actor-start` | `$0.001` per GB, minimum one event | Charged when the Actor starts. The default 1024 MB run charges one start event; a 4 GB run charges four. |
| `ad-scraped` | `$0.001` per ad | Charged once for each clean ad record saved to the dataset. |

Example event fees for one run at the default 1024 MB:

| Saved ads | Ad-event fees | Start-event fee | Event subtotal, excluding platform usage |
| ---: | ---: | ---: | ---: |
| 1 | `$0.001` | `$0.001` | `$0.002` |
| 10 | `$0.010` | `$0.001` | `$0.011` |
| 100 | `$0.100` | `$0.001` | `$0.101` |
| 1,000 | `$1.000` | `$0.001` | `$1.001` |

Compute, Residential proxy traffic, storage and other applicable platform usage are additional. Browser/proxy costs can dominate the ad-event fees, so 1,000 ads are **not `$1` all-in**. Current representative 100- and 500-ad total-cost benchmarks have not been established; do not extrapolate them from an older 10-ad owner test. Inspect your run's actual usage and bill before increasing volume.

Owner check on 30 September 2026: [candidate build 1.0.20](https://console.apify.com/view/runs/T0WJamqZISRJcccja) saved one clean Nike ad in 33.9 seconds at 1024 MB, with about `$0.052` in reported platform usage. The listed one-ad event subtotal is separately `$0.002`, as shown above; the owner check is not a customer billing or creator-profit measurement. Its summary was `limited` / `max_results`, with one saved ad, zero failed searches and zero retries. This verifies a capped one-ad workflow, not a complete archive or a 100-/500-ad cost benchmark; do not extrapolate it to bulk runs.

Failed, blocked, duplicate, or empty records are not charged as `ad-scraped` events. The Actor stops further ad extraction and saving once Apify reports that the event-charge limit has been reached. This is not a guaranteed all-in cap on separately billed platform usage; in-flight browser work and cleanup can still incur usage costs.

An empty or failed run can still incur its start-event and platform-usage costs; ads saved before a partial failure still incur ad-event fees. The table explains existing fees, not a pricing or resource-setting change.

To control cost, start with one search term or one Page ID, one country, active ads, and `maxResults: 1`. Increase volume only after the sample output looks right. Residential proxy is recommended for Facebook reliability.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `keywords` | string array | `["Nike"]` | Find ads whose public advertiser, creative, headline, or destination fields mention the keyword. Up to 5 items. |
| `pageIds` | string array | `[]` | Numeric Facebook Page IDs for an exact advertiser-page search. Up to 5 items. |
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

Live Store example: [Find 10 Active Ads Mentioning Nike in the US](https://apify.com/fascinating_lentil/facebook-ad-library-scraper/examples/track-active-nike-ads-in-the-us). Keyword searches can include ads from retailers and other advertisers that mention the brand; use a numeric Page ID when you need ads from one exact Facebook Page.

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

The following JSON is a synthetic schema illustration, not a live scrape or a test-run result. `platformsList` may reflect the requested filters when source platform evidence is unavailable; it is not always independently observed.

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
  "scrapedAt": "2026-06-10T12:00:00.000Z",
  "searchQuery": "Nike"
}
```

Many commercial ads do not expose spend, impressions, funding, or targeting fields. Those fields are returned as `null` or empty arrays when Meta does not disclose them.

The current implementation always returns `languages: []`. Missing source platform data falls back to the requested platform filters, so `platformsList` alone is not proof of where an ad actually ran.

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

Search pages run one at a time to bound browser memory pressure. The browser skips video-host downloads and Meta-hosted font binaries, while retaining preview images, scripts, data requests, CSS and control icons. Preview images are needed by some cards to initialize their video elements; blocking them can remove video URLs when initial data metadata is unavailable. Complete matching structured media can be read without waiting for a preview. For the rendered-card fallback, the Actor waits up to five seconds for previews in the current bounded batch of candidate ads; unrelated images do not block extraction. It can activate lazy previews in that batch, and a failed or still-loading candidate is deferred instead of being saved prematurely. Ready ads can still be saved, with unresolved previews reported as incomplete coverage using `preview_unready`; if no usable ads can be saved, that search remains retryable. These checks do not establish that every video field is available. The browser may fetch image previews, but it does not download video files or independently verify returned media URLs. Media URLs are read from public page payloads, existing matching-search data responses and rendered attributes. Response metadata can fill missing media URLs only on the same already-observed ad ID, not add new ads or override search-coverage checks. The DOM fallback advances through bounded batches of previously uninspected cards, including when earlier cards were duplicates or did not match the search. This does not guarantee a particular cost or memory ceiling, and multi-search runs may take longer than concurrent searches.

Each fresh retry page performs its own landing-page warm-up. Search snapshots must retain the requested query and filters across two readings. A scope reset on the Ad Library itself may trigger one navigation back to the exact requested URL per page; login, challenge and foreign redirects are not accepted. The scope is checked again after DOM/media extraction, before saving or charging rows. Persistent scope changes or interrupted navigation remain failures, not empty results. This bounded recovery can add one page navigation and does not guarantee access to Meta or a fixed run cost.

### Run coverage summary

Read `FACEBOOK-RUN-SUMMARY` in the run's default key-value store alongside the dataset and run status. It reports aggregate and per-job counters with fixed reasons, not search terms, URLs, page HTML or raw errors:

| Outcome | Meaning |
| --- | --- |
| `results` | Matched ads were observed and saved without a reported source gap or limit. This does **not** prove an exhaustive advertiser or historical archive. |
| `empty` | Every planned search explicitly confirmed no-results in the matching loaded search scope, with no contradictory ad evidence. |
| `partial` | Some usable matched ads were saved, but a terminal search failure or fatal save/crawl error leaves coverage incomplete. |
| `limited` | A result/spending limit, stale-scroll stop or no-new-data condition bounded collection; remaining coverage is not established. Zero newly saved ads can be limited rather than empty. |
| `failed` | Zero saved ads with a failed, unverified or unstarted search, or a fatal save/crawl error. Fatal errors after saving ads instead yield a `partial` summary and a failed Actor status. |

Confirmed empty requires the requested query/Page ID and supported filter parameters to match the loaded Ad Library URL. The scoped `ad_library_main.search_results_connection` must contain `edges: []`, numeric `count: 0` and `page_info.has_next_page: false`, without source errors, conflicting payloads or observed ads. Missing cards, generic empty arrays and unrelated embedded ads do not establish no-results. Blocked pages and unverified searches without matched-ad or authoritative result evidence are retried; exhausted recovery becomes a terminal search failure.

Matched duplicates, or authoritative result evidence with no newly accepted matches, can produce `limited` with reason `no_new_data`; they are not confirmed empty. A request that succeeds after retry does not count as a failed search. Stale scrolling and result/spending caps are limits, not proof that all ads were collected. Any crawl cap that leaves jobs unfinished must not be interpreted as exhaustive coverage.

Read the Actor run status as well as the summary: terminal source gaps with usable rows can finish successfully with `partial`; a fatal save/crawl error fails the Actor even if saved rows yield a `partial` summary. Saved rows remain available. The summary is written after normal completion or handled crawl/save failures, but an abrupt kill, input/proxy or other pre-crawl initialization error, or failure to write the summary can leave it absent. None of the outcomes certifies an exhaustive archive (`exhaustiveArchive` remains `false`).

## Known Limits

- Meta can change the Ad Library layout, field names, or access behavior.
- Some fields are available only for issue, election, or political ads.
- Commercial ads often do not disclose spend or impression ranges.
- Very broad searches can return changing or personalized public result sets.
- Saved results and scrolling stops do not establish exhaustive coverage. Search-page filters are not proof that every output field was independently verified.
- Direct Ad Library search-URL inputs, ad-start date-window inputs and media-type filter inputs are not currently supported.
- This Actor is not affiliated with Meta, Facebook, Instagram, or the Facebook Ad Library.

## Responsible Use

This Actor is intended for lawful collection of publicly available ad-transparency information only. Users are responsible for ensuring their use complies with Meta's terms, robots.txt, applicable privacy laws, and local regulations.

Do not use this Actor to collect, store, sell, or misuse personal data without a lawful basis. The Actor author is not responsible for misuse by end users.

## License

Apache-2.0
