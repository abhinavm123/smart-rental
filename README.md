# Smart Rental

Smart Rental searches the car-rental section of the `booking-com18` API on RapidAPI. It runs the same trip search for each selected renter market, keeps the cheapest matching supplier/vehicle offer, and shows the price spread between markets.

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

3. Put your RapidAPI key in `.env`.

```env
RAPIDAPI_KEY=your_key_here
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
RAPIDAPI_KEY=your_key_here
ADMIN_PASSWORD=use_a_long_unique_password_here
PORT=3000
```

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
