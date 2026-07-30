import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminService } from "./admin-server.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const providerHost = "booking-com18.p.rapidapi.com";
const providerEndpoints = {
  search: `https://${providerHost}/car/search`,
  autocomplete: `https://${providerHost}/car/auto-complete`,
  detail: `https://${providerHost}/car/detail`,
  packages: `https://${providerHost}/car/packages`,
  bookingSummary: `https://${providerHost}/car/booking-summary`
};
const maxOffersPerMarket = 250;
const quoteLifetimeMs = 30 * 60 * 1000;
const maxCachedQuotes = 2000;
const quoteCache = new Map();
const locationCacheLifetimeMs = 30 * 60 * 1000;
const maxCachedLocationQueries = 100;
const locationSuggestionCache = new Map();
const defaultAdminService = createAdminService({
  dataFile: join(root, ".data", "admin.json")
});

const staticAssets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/admin", { file: "admin.html", type: "text/html; charset=utf-8" }],
  ["/admin.html", { file: "admin.html", type: "text/html; charset=utf-8" }],
  ["/admin.css", { file: "admin.css", type: "text/css; charset=utf-8" }],
  ["/admin.js", { file: "admin.js", type: "text/javascript; charset=utf-8" }]
]);

export function createAppServer({ adminService = defaultAdminService } = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (url.pathname.startsWith("/api/admin/")) {
        await handleAdminRequest(request, response, url, adminService);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/events") {
        await handlePublicEventRequest(request, response, adminService);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cars") {
        await handleCarsRequest(request, response, adminService);
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
        await handleQuoteDetailsRequest(quoteMatch[1], response, adminService);
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

async function handleAdminRequest(request, response, url, adminService) {
  const clientId = getClientId(request);

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readJson(request);
    const result = adminService.login(body.password, clientId);
    if (result.status !== 200) {
      sendJson(response, result.status, { error: result.error });
      return;
    }
    sendJson(response, 200, {
      csrfToken: result.csrfToken,
      expiresAt: new Date(result.expiresAt).toISOString()
    }, {
      "Set-Cookie": createSessionCookie(result.token, request)
    });
    return;
  }

  const session = adminService.authenticate(request);
  if (!session) {
    sendJson(response, 401, { error: "Admin authentication is required." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    sendJson(response, 200, {
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
    return;
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "")) {
    if (!isSameOriginRequest(request) || request.headers["x-csrf-token"] !== session.csrfToken) {
      sendJson(response, 403, { error: "The admin security token is invalid." });
      return;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    adminService.logout(session.token, clientId);
    sendJson(response, 200, { status: "signed_out" }, {
      "Set-Cookie": "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/dashboard") {
    sendJson(response, 200, await adminService.getDashboard());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/transactions") {
    try {
      const transaction = await adminService.addTransaction(await readJson(request), clientId);
      sendJson(response, 201, { transaction });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid transaction." });
    }
    return;
  }

  const transactionMatch = request.method === "DELETE"
    ? url.pathname.match(/^\/api\/admin\/transactions\/([a-f0-9-]{36})$/)
    : null;
  if (transactionMatch) {
    const deleted = await adminService.deleteTransaction(transactionMatch[1], clientId);
    sendJson(response, deleted ? 200 : 404, deleted ? { status: "deleted" } : { error: "Transaction not found." });
    return;
  }

  sendJson(response, 404, { error: "Admin endpoint not found." });
}

async function handlePublicEventRequest(request, response, adminService) {
  const body = await readJson(request);
  const accepted = adminService.recordPublicEvent(String(body.type || ""), body.metadata);
  sendJson(response, accepted ? 202 : 400, accepted ? { status: "accepted" } : { error: "Unsupported event type." });
}

function createSessionCookie(token, request) {
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`;
}

function isSameOriginRequest(request) {
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function getClientId(request) {
  return String(request.socket?.remoteAddress || "unknown");
}

async function handleLocationSuggestionsRequest(url, response) {
  const query = String(url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    sendJson(response, 200, { suggestions: [] });
    return;
  }

  const config = getProviderConfig();
  if (!config.apiKey) {
    sendJson(response, 400, { error: "The Booking COM RapidAPI key is not configured on the server." });
    return;
  }

  const endpoint = new URL(config.autocompleteUrl);
  endpoint.searchParams.set("query", query);

  try {
    const suggestions = await getLocationSuggestions(query, async () => {
      const payload = await fetchProviderJson(endpoint, config, 20_000);
      return (Array.isArray(payload?.data) ? payload.data : [])
        .map(normalizeLocationSuggestion)
        .filter(Boolean)
        .slice(0, 8);
    });
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

async function handleCarsRequest(request, response, adminService) {
  const body = await readJson(request);
  const validationError = validateSearchBody(body);
  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  const config = getProviderConfig();
  if (!config.apiKey) {
    sendJson(response, 400, { error: "The Booking COM RapidAPI key is not configured on the server." });
    return;
  }

  let pickupId;
  try {
    pickupId = await resolvePickupId(body, config);
  } catch (error) {
    adminService.recordEvent("search_failed", {
      location: body.location,
      markets: getRequestedMarkets(body).length,
      currency: normalizeCurrency(body.currency)
    });
    sendJson(response, 502, { error: error.message });
    return;
  }

  const markets = getRequestedMarkets(body);
  const requests = markets.map((market) => ({
    market,
    url: buildCarSearchUrl(config.searchUrl, pickupId, body, market)
  }));
  const settled = await Promise.allSettled(
    requests.map(({ url, market }) => fetchProviderJson(url, config, 65_000).then((payload) => ({ market, payload })))
  );

  const successes = [];
  const failures = [];
  settled.forEach((result, index) => {
    const market = requests[index].market;
    if (result.status === "fulfilled") successes.push(result.value);
    else failures.push({ market, error: result.reason?.message || "Provider request failed" });
  });

  if (!successes.length) {
    adminService.recordEvent("search_failed", {
      location: body.location,
      markets: markets.length,
      failures: failures.length,
      currency: normalizeCurrency(body.currency)
    });
    sendJson(response, 502, {
      error: "The rental provider did not return usable results for any selected market.",
      failures
    });
    return;
  }

  const result = combineMarketResults(successes, failures, body, registerQuote);
  adminService.recordEvent("search_completed", {
    location: body.location,
    markets: markets.length,
    offers: result.offers.length,
    failures: failures.length,
    currency: normalizeCurrency(body.currency)
  });
  sendJson(response, 200, result);
}

async function handleQuoteDetailsRequest(quoteId, response, adminService) {
  const quote = getQuote(quoteId);
  if (!quote) {
    adminService.recordEvent("quote_review_failed");
    sendJson(response, 404, { error: "This quote has expired. Run the search again for fresh details." });
    return;
  }

  const config = getProviderConfig();
  if (!config.apiKey) {
    sendJson(response, 400, { error: "The Booking COM RapidAPI key is not configured on the server." });
    return;
  }

  try {
    const details = quote.details || await loadQuoteDetails(quote, config);
    quote.details = details;
    adminService.recordEvent("quote_reviewed");
    sendJson(response, 200, details);
  } catch {
    adminService.recordEvent("quote_review_failed");
    sendJson(response, 502, {
      error: "Additional quote details are unavailable for this vehicle. The search price and basic terms are still shown below."
    });
  }
}

function getProviderConfig() {
  return {
    host: providerHost,
    searchUrl: providerEndpoints.search,
    autocompleteUrl: providerEndpoints.autocomplete,
    apiKey: process.env.RAPIDAPI_KEY || ""
  };
}

async function fetchProviderJson(url, config, timeout) {
  const upstream = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: {
      "x-rapidapi-key": config.apiKey,
      "x-rapidapi-host": config.host,
      "Accept": "application/json"
    }
  });

  const text = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Rental provider returned non-JSON data (${upstream.status}).`);
  }

  if (!upstream.ok || payload?.status === false) {
    throw new Error(`Rental provider request failed (${upstream.status}).`);
  }

  return payload;
}

async function resolvePickupId(body, config) {
  if (body.pickupId) return String(body.pickupId);

  const endpoint = new URL(config.autocompleteUrl);
  endpoint.searchParams.set("query", String(body.location || ""));
  const payload = await fetchProviderJson(endpoint, config, 20_000);
  const first = (Array.isArray(payload?.data) ? payload.data : []).find((item) => item?.id);
  if (!first) throw new Error(`No rental pickup location was found for "${body.location}".`);
  return String(first.id);
}

function buildCarSearchUrl(baseUrl, pickupId, body, market) {
  const url = new URL(baseUrl);

  url.searchParams.set("pickUpId", pickupId);
  url.searchParams.set("pickUpDate", body.pickupDate);
  url.searchParams.set("pickUpTime", body.pickupTime);
  url.searchParams.set("dropOffDate", body.returnDate);
  url.searchParams.set("dropOffTime", body.returnTime);
  url.searchParams.set("sortBy", "price_low_to_high");
  url.searchParams.set("driverAge", "40");
  url.searchParams.set("units", "metric");
  url.searchParams.set("languageCode", "en-gb");
  url.searchParams.set("currencyCode", normalizeCurrency(body.currency));
  url.searchParams.set("countryFlag", market);

  return url;
}

function validateSearchBody(body) {
  if (!body.location && !body.pickupId) return "A pickup location is required.";
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
    if (markets.length >= 6) break;
  }

  return markets.length ? markets : ["gb"];
}

export function normalizeMarket(value) {
  const market = String(value || "").trim().toLowerCase();
  if (market === "uk") return "gb";
  return /^[a-z]{2}$/.test(market) ? market : "";
}

function normalizeLocationSuggestion(item) {
  if (!item?.id) return null;
  return {
    id: String(item.id),
    label: String(item.title || item.name || "Rental location"),
    secondary: String(item.subtitle || [item.city, item.country].filter(Boolean).join(", "))
  };
}

export function combineMarketResults(successes, failures = [], body = {}, createQuoteId = null) {
  const offersByKey = new Map();
  const searchKeys = new Map(
    successes.map(({ market, payload }) => [market, String(payload?.data?.search_key || "")])
  );
  let rawOfferCount = 0;

  for (const { market, payload } of successes) {
    const offers = Array.isArray(payload?.data?.search_results) ? payload.data.search_results : [];
    for (const rawOffer of offers.slice(0, maxOffersPerMarket)) {
      const offer = normalizeProviderOffer(rawOffer, market, body);
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
            market: offer.fromCountry
          })
        : "";
      return {
        ...publicOffer,
        ...(quoteId ? { quoteId } : {}),
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

export function normalizeProviderOffer(rawOffer, market, body = {}) {
  const vehicle = rawOffer?.vehicle_info || {};
  const supplierInfo = rawOffer?.supplier_info || {};
  const contentSupplier = rawOffer?.content?.supplier || {};
  const pricing = rawOffer?.pricing_info || {};
  const totalPrice = positiveNumber(pricing.price) || positiveNumber(pricing.drive_away_price);
  if (!totalPrice) return null;

  const name = String(vehicle.v_name || rawOffer.vehicle_name || "Rental car");
  const category = String(vehicle.group || vehicle.label || "Car");
  const supplier = String(supplierInfo.name || contentSupplier.name || "Supplier");
  const pickup = String(supplierInfo.address || rawOffer.pickup_location || body.location || "Pickup location");
  const vehicleCode = String(vehicle.sipp || vehicle.sipp_code || rawOffer.sipp_code || "");
  const matchKey = [name, category, supplier, pickup].join("|").toLowerCase();
  const id = createHash("sha1").update(matchKey).digest("hex").slice(0, 18);
  const days = tripDays(body.pickupDate, body.pickupTime, body.returnDate, body.returnTime);
  const knownFees = Array.isArray(pricing.fee_breakdown?.known_fees) ? pricing.fee_breakdown.known_fees : [];
  const beforePrice = positiveNumber(pricing.drive_away_price_before);
  const originalPrice = beforePrice > totalPrice ? beforePrice : 0;

  return {
    id,
    matchKey,
    name,
    category,
    similarLabel: getSimilarVehicleLabel(vehicle.group_or_similar, category),
    vehicleCode,
    supplier,
    supplierLogoUrl: String(supplierInfo.logo_url || contentSupplier.imageUrl || ""),
    supplierRating: positiveNumber(contentSupplier.rating?.average || supplierInfo.rating) || 0,
    supplierRatingText: String(contentSupplier.rating?.title || ""),
    supplierReviewCount: String(contentSupplier.rating?.subtitle || ""),
    totalPrice,
    currency: String(pricing.currency || normalizeCurrency(body.currency)),
    originalPrice,
    discountLabel: originalPrice ? getDiscountLabel(rawOffer, totalPrice, originalPrice) : "",
    dailyPrice: totalPrice / days,
    basePrice: positiveNumber(pricing.base_price),
    baseCurrency: String(pricing.base_currency || ""),
    knownFees,
    payWhen: String(pricing.pay_when || ""),
    transmission: String(vehicle.transmission || findVehicleSpec(rawOffer, "TRANSMISSION") || "check terms").toLowerCase(),
    fuel: String(vehicle.fuel_policy_description || vehicle.fuel_policy || vehicle.fuel_type || "check terms").toLowerCase(),
    mileage: String(vehicle.mileage || findVehicleSpec(rawOffer, "MILEAGE") || (vehicle.unlimited_mileage ? "unlimited mileage" : "check terms")).toLowerCase(),
    cancellation: vehicle.free_cancellation || hasBadge(rawOffer, "free cancellation") ? "free cancellation" : "check terms",
    airConditioning: Boolean(vehicle.aircon),
    seats: Number(vehicle.seats) || 0,
    doors: Number(vehicle.doors) || 0,
    pickup,
    imageUrl: String(vehicle.image_url || vehicle.image_thumbnail_url || rawOffer.image_url || ""),
    vehicleId: String(vehicle.v_id || rawOffer.vehicle_id || ""),
    fromCountry: market
  };
}

function findVehicleSpec(offer, token) {
  const specs = Array.isArray(offer?.content?.vehicleSpecs) ? offer.content.vehicleSpecs : [];
  return specs.find((spec) => String(spec?.icon || "").toUpperCase().includes(token))?.text || "";
}

function hasBadge(offer, text) {
  const badges = Array.isArray(offer?.content?.badges) ? offer.content.badges : [];
  return badges.some((badge) => String(badge?.text || "").toLowerCase().includes(text));
}

function getDiscountLabel(offer, currentPrice, originalPrice) {
  const badges = Array.isArray(offer?.content?.badges) ? offer.content.badges : [];
  const badge = badges
    .map((item) => plainText(item?.text))
    .find((text) => /discount|price cut|%\s*off|save/i.test(text));
  if (badge) return badge;

  const percentage = Math.round((1 - currentPrice / originalPrice) * 100);
  return percentage > 0 ? `${percentage}% price cut` : "Price cut";
}

function getSimilarVehicleLabel(value, category) {
  if (value === false || value === null || value === undefined) return "";
  const text = plainText(value);
  if (!text || /^(false|no|0)$/i.test(text)) return "";
  if (/similar/i.test(text) && !/^or similar$/i.test(text)) return text;
  return `or similar ${category}`;
}

function registerQuote({ vehicleId, searchKey, market }) {
  if (!vehicleId || !searchKey || !market) return "";

  const now = Date.now();
  pruneQuoteCache(now);
  const id = createHash("sha256")
    .update(`${vehicleId}\0${searchKey}\0${market}`)
    .digest("hex")
    .slice(0, 24);

  quoteCache.delete(id);
  quoteCache.set(id, {
    vehicleId,
    searchKey,
    market,
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

async function loadQuoteDetails(quote, config) {
  if (quote.pending) return quote.pending;

  quote.pending = (async () => {
    const query = new URLSearchParams({
      vehicleId: quote.vehicleId,
      searchKey: quote.searchKey,
      units: "metric"
    });
    const requests = [
      ["detail", `${providerEndpoints.detail}?${query}`],
      ["packages", `${providerEndpoints.packages}?${query}`],
      ["summary", `${providerEndpoints.bookingSummary}?${query}`]
    ];
    const settled = await Promise.allSettled(
      requests.map(([, url]) => fetchProviderJson(url, config, 65_000))
    );

    const payloads = {};
    const warnings = [];
    settled.forEach((result, index) => {
      const name = requests[index][0];
      if (result.status === "fulfilled") payloads[name] = result.value;
      else warnings.push(`${formatQuoteSectionName(name)} unavailable`);
    });

    if (!Object.keys(payloads).length) {
      throw new Error("The provider returned no additional quote details.");
    }

    return normalizeQuoteDetails(
      payloads.detail,
      payloads.packages,
      payloads.summary,
      warnings
    );
  })();

  try {
    return await quote.pending;
  } finally {
    quote.pending = null;
  }
}

function formatQuoteSectionName(name) {
  return {
    detail: "Vehicle details",
    packages: "Protection packages",
    summary: "Booking summary"
  }[name] || "Quote section";
}

export function normalizeQuoteDetails(
  detailPayload = {},
  packagesPayload = {},
  summaryPayload = {},
  warnings = []
) {
  const detail = detailPayload?.data || {};
  const summary = summaryPayload?.data?.content || {};
  const summaryProduct = summary.product || {};
  const vehicle = detail.vehicle || {};
  const specifications = vehicle.specification || {};
  const reviewSupplier = detail.content?.reviews?.supplier || {};
  const supplier = detail.supplier || {};
  const detailPrice = vehicle.price?.display || vehicle.price?.driveAway || {};
  const totalDisplay = String(
    summary.priceBreakdown?.total?.primaryPrice?.price
    || summary.footer?.title
    || formatProviderMoney(detailPrice.value, detailPrice.currency)
  );

  const included = uniqueText([
    ...toArray(detail.whatsIncluded?.items).map((item) => item?.text || item?.title),
    ...toArray(detail.whatsIncluded?.infoItems).map((item) => item?.text || item?.title)
  ]);
  const importantInfo = uniqueText(
    toArray(detail.importantInfo?.items).map((item) => item?.text || item?.title)
  );
  const allFees = [
    ...toArray(vehicle.fees?.payableFees),
    ...toArray(vehicle.fees?.otherFees)
  ];
  const packageSource = toArray(packagesPayload?.data?.packages).length
    ? toArray(packagesPayload.data.packages)
    : toArray(detail.packages);

  return {
    vehicle: {
      title: String(summaryProduct.vehicle?.title || vehicle.makeAndModel || "Rental car"),
      subtitle: String(summaryProduct.vehicle?.subtitle || vehicle.carClass || ""),
      imageUrl: safeHttpsUrl(summaryProduct.vehicle?.imageUrl || vehicle.imageUrl),
      carClass: String(vehicle.carClass || ""),
      specifications: {
        transmission: String(specifications.transmission || ""),
        fuelPolicy: String(specifications.fuelPolicy || ""),
        mileage: String(specifications.mileage || ""),
        seats: Number(specifications.numberOfSeats) || 0,
        doors: Number(specifications.numberOfDoors) || 0,
        airConditioning: Boolean(specifications.airConditioning),
        smallSuitcases: Number(specifications.smallSuitcases) || 0,
        bigSuitcases: Number(specifications.bigSuitcases) || 0
      }
    },
    supplier: {
      name: String(reviewSupplier.name || supplier.name || ""),
      imageUrl: safeHttpsUrl(summaryProduct.supplier?.imageUrl || supplier.imageUrl || reviewSupplier.imageUrl),
      rating: positiveNumber(reviewSupplier.rating?.average || supplier.rating),
      ratingText: String(reviewSupplier.rating?.title || ""),
      reviewCount: String(reviewSupplier.rating?.subtitle || ""),
      locationType: String(supplier.locationType || "")
    },
    trip: {
      pickupName: String(summaryProduct.pickUp?.name || detail.depots?.pickup?.name || ""),
      pickupDateTime: String(summaryProduct.pickUp?.dateTime || ""),
      dropoffName: String(summaryProduct.dropOff?.name || detail.depots?.dropoff?.name || ""),
      dropoffDateTime: String(summaryProduct.dropOff?.dateTime || ""),
      duration: String(summaryProduct.duration || (vehicle.rentalDurationInDays ? `${vehicle.rentalDurationInDays} days` : ""))
    },
    price: {
      totalDisplay,
      currency: String(detailPrice.currency || ""),
      value: positiveNumber(detailPrice.value),
      payWhen: String(vehicle.payWhenText || vehicle.price?.payWhen || ""),
      freeCancellation: String(summary.freeCancellation || (vehicle.freeCancellation ? "Free cancellation" : ""))
    },
    included,
    fees: allFees.map(normalizeQuoteFee).filter(Boolean),
    packages: packageSource.map(normalizeQuotePackage).filter(Boolean),
    importantInfo,
    priceBreakdown: normalizePriceBreakdown(summary.priceBreakdown),
    termsUrl: safeBookingUrl(
      detail.links?.fullRentalTerms?.url || detail.importantInfo?.cta?.url
    ),
    warnings: uniqueText(warnings)
  };
}

function normalizeQuoteFee(fee) {
  if (!fee || typeof fee !== "object") return null;
  const price = fee.displayPrice || fee.price || {};
  return {
    name: titleCase(fee.name || fee.type || "Fee"),
    amount: positiveNumber(price.amount ?? price.minimumAmount ?? price.maximumAmount),
    currency: String(price.currency || ""),
    includedInPrice: Boolean(fee.includedInPrice),
    alwaysPayable: Boolean(fee.alwaysPayable)
  };
}

function normalizeQuotePackage(item) {
  if (!item || typeof item !== "object") return null;
  const details = item.details || {};
  const moreInfo = item.moreInformation?.moreInfoData || {};
  const atAGlance = moreInfo.body?.atAGlance || {};
  const title = String(
    details.pageTitle
    || item.content?.title
    || moreInfo.header?.title
    || item.id
    || "Protection package"
  );
  const highlights = uniqueText([
    item.content?.included,
    ...toArray(atAGlance.list).map((entry) => entry?.title || entry?.text)
  ]);

  return {
    id: String(item.id || title),
    title,
    description: plainText(item.content?.description || atAGlance.title || ""),
    price: String(
      item.price?.displayPrice
      || details.priceDisplay?.displayPrice
      || item.content?.price?.displayPrice
      || ""
    ),
    highlights,
    documentUrl: safeBookingUrl(details.disclaimers?.documents?.[0]?.url),
    informationUrl: safeBookingUrl(details.footer?.placeholders?.[0]?.link?.url)
  };
}

function normalizePriceBreakdown(priceBreakdown) {
  return toArray(priceBreakdown?.sections).flatMap((section) =>
    toArray(section?.items).map((item) => ({
      title: String(item?.title || "Charge"),
      subtitle: String(item?.subtitle || item?.note || ""),
      price: String(item?.price || ""),
      details: toArray(item?.details?.items).map((detail) => ({
        title: String(detail?.title || "Charge"),
        price: String(detail?.price || "")
      }))
    }))
  );
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueText(values) {
  return [...new Set(values.map(plainText).filter(Boolean))];
}

function plainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function safeBookingUrl(value) {
  const url = safeHttpsUrl(value);
  if (!url) return "";
  return new URL(url).hostname === "cars.booking.com" ? url : "";
}

function formatProviderMoney(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !currency) return "";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function positiveNumber(value) {
  const number = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tripDays(pickupDate, pickupTime, returnDate, returnTime) {
  const start = new Date(`${pickupDate || ""}T${pickupTime || "00:00"}`);
  const end = new Date(`${returnDate || ""}T${returnTime || "00:00"}`);
  const days = Math.ceil((end - start) / 86_400_000);
  return Number.isFinite(days) && days > 0 ? days : 1;
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
