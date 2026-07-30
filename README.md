# Smart Rental

Smart Rental searches car-rental providers through a small provider-adapter layer. The included `booking-com18` adapter uses RapidAPI, runs the same trip search for each selected renter market, keeps the cheapest matching supplier/vehicle offer, and shows the price spread between markets.

## How it works

- The browser requests rental locations from `/api/locations`.
- The Node server calls `/car/auto-complete` and returns provider location IDs.
- A search calls `/car/search` once per selected `countryFlag`, with identical location, dates, driver age, language, and currency.
- Results are normalized and matched by vehicle, category, supplier, and pickup address before their prices are compared.
- Each result gets an opaque, short-lived quote ID. Opening **Review live quote** loads `/car/detail`, `/car/packages`, and `/car/booking-summary` on the server using the matching vehicle ID and search key.
- The quote dialog shows the provider's confirmed total, price breakdown, fees, inclusions, protection packages, trip summary, important information, and rental-terms link.
- Operational events are recorded without API keys, search keys, or customer details and are available to authenticated administrators.
- The RapidAPI key stays on the server and is never sent to browser code.

## Setup

1. Subscribe to the `booking-com18` API on RapidAPI.
2. Copy the example environment file if `.env` does not exist.

```powershell
Copy-Item .env.example .env
```

3. Put your provider and RapidAPI key in `.env`.

```env
RENTAL_PROVIDER=booking-com18
RENTAL_API_KEY=your_key_here
ADMIN_PASSWORD=use_a_long_unique_password_here
```

4. Start the app.

```powershell
npm start
```

5. Open `http://localhost:3000`.

## Scripts

```powershell
npm start
npm run check
npm test
```

## Configuration

```env
RENTAL_PROVIDER=booking-com18
RENTAL_API_KEY=your_key_here
RENTAL_API_HOST=booking-com18.p.rapidapi.com
RENTAL_API_BASE_URL=https://booking-com18.p.rapidapi.com
RENTAL_API_AUTOCOMPLETE_PATH=/car/auto-complete
RENTAL_API_SEARCH_PATH=/car/search
RENTAL_API_DETAIL_PATH=/car/detail
RENTAL_API_PACKAGES_PATH=/car/packages
RENTAL_API_BOOKING_SUMMARY_PATH=/car/booking-summary
ADMIN_PASSWORD=use_a_long_unique_password_here
PORT=3000
```

`RAPIDAPI_KEY` remains supported as a backwards-compatible fallback. The `RENTAL_API_*_PATH` settings let you switch hosts or endpoint paths without code changes when the replacement API uses the same request and response format.

## Changing rental APIs

The browser and the main server use a provider-neutral quote format. Provider-specific request parameters and response mapping live in `providers/`.

- If a replacement is compatible with `booking-com18`, update `RENTAL_API_HOST`, `RENTAL_API_BASE_URL`, the endpoint paths, and the key in `.env`.
- If its JSON or search flow differs, copy the shape of `providers/booking-com18.js`, implement the provider contract, and register it in `providers/index.js`. Then switching between installed adapters only requires changing `RENTAL_PROVIDER`.

Every adapter supplies its own configuration check, location search, pickup resolution, market search, search-key and offer extraction, offer normalization, and live quote-detail loading. This keeps authentication and API changes out of the website, saved-quote, comparison, admin, and security code.

## Admin dashboard

Open `http://localhost:3000/admin` and sign in with `ADMIN_PASSWORD`.

The protected dashboard includes search and quote activity, top locations, saved-quote checks, API failures, a manual cashflow ledger, currency-separated totals, pending entries, gross booking value, and a 14-day activity view.

Admin sessions use an HTTP-only, same-site cookie, expire after eight hours, and require a CSRF token for changes. Failed logins are rate limited. Ledger and analytics data are stored in `.data/admin.json`, which is excluded from Git.

Cashflow entries are manual until a completed-booking or affiliate conversion feed is connected. Operational search activity must not be treated as booking revenue.

## Notes

- Keep the display currency fixed when comparing countries; otherwise exchange-rate changes can look like market-price changes.
- UK and GBP are selected by default; users can opt into additional renter markets.
- The backend uses a default driver age of 40 because the provider accepts ages 30-65.
- The provider is an unofficial API that reproduces public Booking.com data. Treat its schema and availability as third-party dependencies and keep fixture tests for the fields the app consumes.
- Provider calls may consume RapidAPI quota. A search makes one call per selected renter market; the first detail view for a result makes three additional calls. Quote details are cached for 30 minutes.
- The repaired endpoints provide detailed quote and rental-terms data, but still do not return a reliable exact-vehicle checkout URL. The app therefore stops at quote review rather than presenting a misleading booking button.
