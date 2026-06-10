# Resume Notes — Facebook Ad Library Scraper (PARKED)

## Status
Build is fixed, compiles, runs, and handles blocks gracefully (never charges for failed/blocked runs). Pricing configured: `ad-scraped` @ $1.00/1000. On GitHub and pushed to Apify. **Not earning** — extraction is blocked.

## What works
- Compiles clean; `actor.json` pricing valid (PAY_PER_EVENT `ad-scraped`).
- We solved the initial **403 block**: the fix was removing the mismatched Client-Hint headers + a **session warm-up** (load the Ad Library landing first to get cookies), then navigate to the query URL. Past that, the page loads.

## What's blocking (where it stopped)
- After bypassing the 403, the **extraction hangs / returns 0 ads**: the ad-card selectors (`x1dr75xp`, `[role="article"]`, etc.) are far too broad and match thousands of generic divs, so per-card queries grind to a timeout.

## What it needs next (turnkey resume)
1. **Save the rendered HTML once** to the key-value store on a successful (warmed) run, then read Facebook's *real* DOM to write precise ad-card selectors. (Add a debug step: `await Actor.setValue('page.html', await page.content())`.)
2. **Better target the ad container** — each ad is in a stable wrapper; identify it from the saved HTML instead of broad class matches.
3. Consider Facebook's Ad Library **GraphQL endpoint** (`/api/graphql/`) which returns ad JSON — more reliable than DOM, but needs the right doc_id + headers.
4. Likely needs a **paid Cloudflare/anti-bot unblocker** or residential + good fingerprinting for sustained runs.

## Test command
```bash
apify push
# then run: { "keywords": ["Nike"], "country": "US", "maxResults": 10, "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] } }
```
Watch for: warm-up log, no 403, and `totalScraped > 0`.
