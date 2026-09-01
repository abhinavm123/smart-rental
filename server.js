import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bookingCom18Provider } from "./providers/booking-com18.js";
import { getRentalProvider } from "./providers/index.js";

export {
  normalizeProviderOffer,
  normalizeQuoteDetails
} from "./providers/booking-com18.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const maxOffersPerMarket = 500;
const maxRenterMarkets = 7;
const quoteLifetimeMs = 30 * 60 * 1000;
const maxCachedQuotes = 2000;
const quoteCache = new Map();
const locationCacheLifetimeMs = 30 * 60 * 1000;
const maxCachedLocationQueries = 100;
const locationSuggestionCache = new Map();
const staticAssets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }]
]);

export function createAppServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (request.method === "POST" && url.pathname === "/api/cars") {
        await handleCarsRequest(request, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/locations") {
        await handleLocationSuggestionsRequest(url, response);
        return;
      }

      const quoteMatch = request.method === "GET"
        ? url.pathname.match(/^\/api\/quotes\/([a-f0-9]{24})$/)
        : null;
      if (quoteMatch) {
        await handleQuoteDetailsRequest(quoteMatch[1], response);
        return;
      }

      if (request.method === "GET") {
        await serveStatic(url.pathname, response);
        return;
      }

      sendJson(response, 405, { error: "Method not allowed" });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      sendJson(response, status, { error: error.message || "Server error" });
    }
  });
}

async function loadEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;

  const contents = await readFile(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

async function serveStatic(pathname, response) {
  const asset = staticAssets.get(pathname);
  if (!asset) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const body = await readFile(join(root, asset.file));
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function handleLocationSuggestionsRequest(url, response) {
  const query = String(url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    sendJson(response, 200, { suggestions: [] });
    return;
  }

  const provider = getRentalProvider();
  const config = provider.getConfig();
  if (!provider.isConfigured(config)) {
    sendJson(response, 400, {
      error: `${provider.displayName} is not configured on the server. ${provider.configurationError}`
    });
    return;
  }

  try {
    const suggestions = await getLocationSuggestions(
      `${provider.id}:${query}`,
      () => provider.searchLocations(query, config)
    );
    sendJson(response, 200, { suggestions });
  } catch (error) {
    sendJson(response, 502, { error: error.message });
  }
}

async function getLocationSuggestions(query, loadSuggestions) {
  const cacheKey = query.toLocaleLowerCase("en-GB");
  const now = Date.now();
  const cached = locationSuggestionCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    locationSuggestionCache.delete(cacheKey);
    locationSuggestionCache.set(cacheKey, cached);
    return cached.pending;
  }

  if (cached) locationSuggestionCache.delete(cacheKey);
  pruneLocationSuggestionCache(now);

  const entry = {
    expiresAt: now + locationCacheLifetimeMs,
    pending: null
  };
  entry.pending = loadSuggestions().catch((error) => {
    if (locationSuggestionCache.get(cacheKey) === entry) {
      locationSuggestionCache.delete(cacheKey);
    }
    throw error;
  });
  locationSuggestionCache.set(cacheKey, entry);
  return entry.pending;
}

function pruneLocationSuggestionCache(now) {
  for (const [key, entry] of locationSuggestionCache) {
    if (entry.expiresAt <= now) locationSuggestionCache.delete(key);
  }
  while (locationSuggestionCache.size >= maxCachedLocationQueries) {
    locationSuggestionCache.delete(locationSuggestionCache.keys().next().value);
  }
}

async function handleCarsRequest(request, response) {
  const body = await readJson(request);
  const validationError = validateSearchBody(body);
  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  const provider = getRentalProvider();
  const config = provider.getConfig();
  if (!provider.isConfigured(config)) {
    sendJson(response, 400, {
      error: `${provider.displayName} is not configured on the server. ${provider.configurationError}`
    });
    return;
  }

  let pickupId;
  let dropOffId = "";
  try {
    [pickupId, dropOffId] = await Promise.all([
      provider.resolvePickupId(body, config),
      body.differentDropoff
        ? provider.resolveDropOffId(body, config)
        : Promise.resolve("")
    ]);
  } catch (error) {
    sendJson(response, 502, { error: error.message });
    return;
  }

  const markets = getRequestedMarkets(body);
  const settled = await Promise.allSettled(
    markets.map((market) => provider.searchCars({
      pickupId,
      dropOffId,
      body,
      market,
      config
    }).then((payload) => ({ market, payload })))
  );

  const successes = [];
  const failures = [];
  settled.forEach((result, index) => {
    const market = markets[index];
    if (result.status === "fulfilled") successes.push(result.value);
    else failures.push({ market, error: result.reason?.message || "Provider request failed" });
  });

  if (!successes.length) {
    sendJson(response, 502, {
      error: "The rental provider did not return usable results for any selected market.",
      failures
    });
    return;
  }

  const result = combineMarketResults(
    successes,
    failures,
    { ...body, pickupId, dropOffId },
    registerQuote,
    provider,
    config
  );
  sendJson(response, 200, result);
}

async function handleQuoteDetailsRequest(quoteId, response) {
  const quote = getQuote(quoteId);
  if (!quote) {
    sendJson(response, 404, { error: "This quote has expired. Run the search again for fresh details." });
    return;
  }

  const provider = getRentalProvider(quote.providerId);
  const config = provider.getConfig();
  if (!provider.isConfigured(config)) {
    sendJson(response, 400, {
      error: `${provider.displayName} is not configured on the server. ${provider.configurationError}`
    });
    return;
  }

  try {
    const details = quote.details || await loadQuoteDetails(quote, provider, config);
    quote.details = details;
    sendJson(response, 200, details);
  } catch {
    sendJson(response, 502, {
      error: "Additional quote details are unavailable for this vehicle. The search price and basic terms are still shown below."
    });
  }
}

function validateSearchBody(body) {
  if (!body.location && !body.pickupId) return "A pickup location is required.";
  if (body.differentDropoff && !body.dropOffLocation && !body.dropOffId) {
    return "A drop-off location is required when returning the car somewhere else.";
  }
  if (body.driverAge === undefined || body.driverAge === null || body.driverAge === "") {
    return "Driver age is required.";
  }
  const driverAge = Number(body.driverAge);
  if (!Number.isInteger(driverAge) || driverAge < 18 || driverAge > 99) {
    return "Driver age must be between 18 and 99.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.pickupDate || ""))) return "A valid pickup date is required.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.returnDate || ""))) return "A valid return date is required.";
  if (!/^\d{2}:\d{2}$/.test(String(body.pickupTime || ""))) return "A valid pickup time is required.";
  if (!/^\d{2}:\d{2}$/.test(String(body.returnTime || ""))) return "A valid return time is required.";

  const start = new Date(`${body.pickupDate}T${body.pickupTime}`);
  const end = new Date(`${body.returnDate}T${body.returnTime}`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) {
    return "Return must be after pickup.";
  }
  return "";
}

function normalizeCurrency(value) {
  const currency = String(value || "GBP").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "GBP";
}

function getRequestedMarkets(body) {
  const requested = Array.isArray(body.fromCountries) && body.fromCountries.length
    ? body.fromCountries
    : [body.fromCountry || "gb"];
  const markets = [];

  for (const value of requested) {
    const market = normalizeMarket(value);
    if (market && !markets.includes(market)) markets.push(market);
    if (markets.length >= maxRenterMarkets) break;
  }

  return markets.length ? markets : ["gb"];
}

export function normalizeMarket(value) {
  const market = String(value || "").trim().toLowerCase();
  if (market === "uk") return "gb";
  return /^[a-z]{2}$/.test(market) ? market : "";
}

export function combineMarketResults(
  successes,
  failures = [],
  body = {},
  createQuoteId = null,
  provider = bookingCom18Provider,
  providerConfig = {}
) {
  const offersByKey = new Map();
  const searchKeys = new Map(
    successes.map(({ market, payload }) => [market, provider.getSearchKey(payload)])
  );
  let rawOfferCount = 0;

  for (const { market, payload } of successes) {
    const offers = provider.getOffers(payload);
    for (const rawOffer of offers.slice(0, maxOffersPerMarket)) {
      const offer = provider.normalizeOffer(rawOffer, market, body);
      if (!offer || !(offer.totalPrice > 0)) continue;
      rawOfferCount += 1;

      const key = offer.matchKey;
      const variant = {
        country: market,
        price: offer.totalPrice
      };
      const existing = offersByKey.get(key);

      if (!existing) {
        offersByKey.set(key, { offer, variants: new Map([[market, variant]]) });
        continue;
      }

      const currentMarketVariant = existing.variants.get(market);
      if (!currentMarketVariant || variant.price < currentMarketVariant.price) {
        existing.variants.set(market, variant);
      }
      if (offer.totalPrice < existing.offer.totalPrice) existing.offer = offer;
    }
  }

  const offers = [...offersByKey.values()]
    .map(({ offer, variants }) => {
      const { matchKey, vehicleId, ...publicOffer } = offer;
      const orderedVariants = [...variants.values()].sort((a, b) => a.price - b.price);
      const minPrice = orderedVariants[0].price;
      const maxPrice = orderedVariants.at(-1).price;
      const quoteId = typeof createQuoteId === "function"
        ? createQuoteId({
            vehicleId,
            searchKey: searchKeys.get(offer.fromCountry) || "",
            market: offer.fromCountry,
            providerId: provider.id
          })
        : "";
      const bookingUrl = typeof provider.buildBookingUrl === "function"
        ? provider.buildBookingUrl({
            vehicleId,
            market: offer.fromCountry,
            body: { ...body, currency: publicOffer.currency },
            config: providerConfig
          })
        : "";
      return {
        ...publicOffer,
        ...(quoteId ? { quoteId } : {}),
        ...(bookingUrl ? { bookingUrl } : {}),
        priceComparison: {
          countriesChecked: orderedVariants.map((variant) => variant.country),
          spread: maxPrice - minPrice
        }
      };
    })
    .sort((a, b) => a.totalPrice - b.totalPrice);

  return {
    offers,
    meta: {
      markets: successes.map(({ market }) => market),
      failures,
      sourceOfferCount: rawOfferCount,
      offerCount: offers.length
    }
  };
}

function registerQuote({ vehicleId, searchKey, market, providerId }) {
  if (!vehicleId || !searchKey || !market) return "";

  const now = Date.now();
  pruneQuoteCache(now);
  const id = createHash("sha256")
    .update(`${providerId}\0${vehicleId}\0${searchKey}\0${market}`)
    .digest("hex")
    .slice(0, 24);

  quoteCache.delete(id);
  quoteCache.set(id, {
    vehicleId,
    searchKey,
    market,
    providerId,
    expiresAt: now + quoteLifetimeMs,
    details: null,
    pending: null
  });
  return id;
}

function getQuote(id) {
  const quote = quoteCache.get(id);
  if (!quote) return null;
  if (quote.expiresAt <= Date.now()) {
    quoteCache.delete(id);
    return null;
  }
  return quote;
}

function pruneQuoteCache(now) {
  for (const [id, quote] of quoteCache) {
    if (quote.expiresAt <= now) quoteCache.delete(id);
  }
  while (quoteCache.size >= maxCachedQuotes) {
    quoteCache.delete(quoteCache.keys().next().value);
  }
}

async function loadQuoteDetails(quote, provider, config) {
  if (quote.pending) return quote.pending;

  quote.pending = provider.loadQuoteDetails(quote, config);

  try {
    return await quote.pending;
  } finally {
    quote.pending = null;
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await loadEnv();
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, () => {
    console.log(`Smart Rental running at http://localhost:${port}`);
  });
}
