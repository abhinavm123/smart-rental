import { createHash } from "node:crypto";

const defaultHost = "booking-com18.p.rapidapi.com";
const defaultPaths = {
  search: "/car/search",
  autocomplete: "/car/auto-complete",
  detail: "/car/detail",
  packages: "/car/packages",
  bookingSummary: "/car/booking-summary"
};

export const bookingCom18Provider = {
  id: "booking-com18",
  displayName: "Booking.com 18 via RapidAPI",
  getConfig: createBookingCom18Config,
  isConfigured: (config) => Boolean(config.apiKey),
  configurationError: "Set RENTAL_API_KEY (or RAPIDAPI_KEY) in .env.",
  buildBookingUrl,
  getSearchKey: (payload) => String(payload?.data?.search_key || ""),
  getOffers: (payload) => Array.isArray(payload?.data?.search_results)
    ? payload.data.search_results
    : [],
  normalizeOffer: normalizeProviderOffer,
  searchLocations,
  resolvePickupId,
  resolveDropOffId,
  searchCars,
  loadQuoteDetails
};

export function createBookingCom18Config(env = process.env) {
  const host = String(env.RENTAL_API_HOST || env.RAPIDAPI_HOST || defaultHost).trim();
  const baseUrl = normalizeBaseUrl(env.RENTAL_API_BASE_URL || `https://${host}`);

  return {
    apiKey: String(env.RENTAL_API_KEY || env.RAPIDAPI_KEY || "").trim(),
    bookingAffiliateId: normalizeAffiliateId(env.BOOKING_AFFILIATE_ID),
    host,
    endpoints: {
      search: endpointUrl(baseUrl, env.RENTAL_API_SEARCH_PATH || defaultPaths.search),
      autocomplete: endpointUrl(baseUrl, env.RENTAL_API_AUTOCOMPLETE_PATH || defaultPaths.autocomplete),
      detail: endpointUrl(baseUrl, env.RENTAL_API_DETAIL_PATH || defaultPaths.detail),
      packages: endpointUrl(baseUrl, env.RENTAL_API_PACKAGES_PATH || defaultPaths.packages),
      bookingSummary: endpointUrl(
        baseUrl,
        env.RENTAL_API_BOOKING_SUMMARY_PATH || defaultPaths.bookingSummary
      )
    }
  };
}

export function buildBookingUrl({ vehicleId, market, body = {}, config = {} }) {
  const id = String(vehicleId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return "";

  const pickupDate = parseDate(body.pickupDate);
  const returnDate = parseDate(body.returnDate);
  const pickupTime = parseTime(body.pickupTime);
  const returnTime = parseTime(body.returnTime);
  if (!pickupDate || !returnDate || !pickupTime || !returnTime) return "";

  const country = /^[a-z]{2}$/i.test(String(market || ""))
    ? String(market).toLowerCase()
    : "gb";
  const currency = /^[A-Z]{3}$/.test(String(body.currency || "").toUpperCase())
    ? String(body.currency).toUpperCase()
    : "GBP";
  const locationName = String(body.location || "Pickup location").trim().slice(0, 160);
  const differentDropoff = Boolean(body.differentDropoff && (body.dropOffId || body.dropOffLocation));
  const dropLocationName = differentDropoff
    ? String(body.dropOffLocation || "Drop-off location").trim().slice(0, 160)
    : locationName;
  const pickupCoordinates = decodeLocationCoordinates(body.pickupId);
  const dropoffCoordinates = differentDropoff
    ? decodeLocationCoordinates(body.dropOffId)
    : pickupCoordinates;
  const url = new URL("https://cars.booking.com/search-results");

  url.searchParams.set("vehicleId", id);
  url.searchParams.set("vehicleInfo.vehicle.id", id);
  url.searchParams.set("prefcurrency", currency);
  url.searchParams.set("preflang", "en");
  url.searchParams.set("cor", country);
  url.searchParams.set("driversAge", normalizeDriverAge(body.driverAge));
  setTripParameters(url, "pu", pickupDate, pickupTime);
  setTripParameters(url, "do", returnDate, returnTime);
  url.searchParams.set("locationName", locationName);
  url.searchParams.set("dropLocationName", dropLocationName);

  if (pickupCoordinates) {
    url.searchParams.set("location", "-1");
    url.searchParams.set("coordinates", pickupCoordinates);
  }
  if (dropoffCoordinates) {
    url.searchParams.set("dropLocation", "-1");
    url.searchParams.set("dropCoordinates", dropoffCoordinates);
  }

  const affiliateId = normalizeAffiliateId(config.bookingAffiliateId);
  if (affiliateId) url.searchParams.set("aid", affiliateId);
  return url.href;
}

function parseDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { year: match[1], month: String(Number(match[2])), day: String(Number(match[3])) } : null;
}

function parseTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  return match ? { hour: String(Number(match[1])), minute: String(Number(match[2])) } : null;
}

function setTripParameters(url, prefix, date, time) {
  url.searchParams.set(`${prefix}Day`, date.day);
  url.searchParams.set(`${prefix}Month`, date.month);
  url.searchParams.set(`${prefix}Year`, date.year);
  url.searchParams.set(`${prefix}Hour`, time.hour);
  url.searchParams.set(`${prefix}Minute`, time.minute);
}

function decodeLocationCoordinates(value) {
  try {
    const decoded = JSON.parse(Buffer.from(String(value || ""), "base64").toString("utf8"));
    const latitude = Number(decoded.latitude);
    const longitude = Number(decoded.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return "";
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return "";
    return `${latitude},${longitude}`;
  } catch {
    return "";
  }
}

function normalizeAffiliateId(value) {
  const id = String(value || "").trim();
  return /^\d{1,20}$/.test(id) ? id : "";
}

async function searchLocations(query, config) {
  const endpoint = new URL(config.endpoints.autocomplete);
  endpoint.searchParams.set("query", query);
  const payload = await fetchProviderJson(endpoint, config, 20_000);

  return (Array.isArray(payload?.data) ? payload.data : [])
    .map(normalizeLocationSuggestion)
    .filter(Boolean)
    .slice(0, 8);
}

async function resolvePickupId(body, config) {
  return resolveLocationId(body.pickupId, body.location, config, "pickup");
}

async function resolveDropOffId(body, config) {
  if (!body.differentDropoff) return "";
  return resolveLocationId(body.dropOffId, body.dropOffLocation, config, "drop-off");
}

async function resolveLocationId(id, location, config, label) {
  if (id) return String(id);

  const suggestions = await searchLocations(String(location || ""), config);
  const first = suggestions.find((item) => item.id);
  if (!first) throw new Error(`No rental ${label} location was found for "${location}".`);
  return first.id;
}

export async function searchCars({ pickupId, dropOffId = "", body, market, config }) {
  const url = new URL(config.endpoints.search);
  url.searchParams.set("pickUpId", pickupId);
  url.searchParams.set("pickUpDate", body.pickupDate);
  url.searchParams.set("pickUpTime", body.pickupTime);
  url.searchParams.set("dropOffDate", body.returnDate);
  url.searchParams.set("dropOffTime", body.returnTime);
  if (dropOffId) url.searchParams.set("dropOffId", dropOffId);
  url.searchParams.set("sortBy", "price_low_to_high");
  url.searchParams.set("driverAge", normalizeDriverAge(body.driverAge));
  url.searchParams.set("units", "metric");
  url.searchParams.set("languageCode", "en-gb");
  url.searchParams.set("currencyCode", normalizeCurrency(body.currency));
  url.searchParams.set("countryFlag", market);
  return fetchProviderJson(url, config, 65_000);
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

function normalizeLocationSuggestion(item) {
  if (!item?.id) return null;
  return {
    id: String(item.id),
    label: String(item.title || item.name || "Rental location"),
    secondary: String(item.subtitle || [item.city, item.country].filter(Boolean).join(", "))
  };
}

export function normalizeProviderOffer(rawOffer, market, body = {}) {
  const vehicle = rawOffer?.vehicle_info || {};
  const supplierInfo = rawOffer?.supplier_info || {};
  const contentSupplier = rawOffer?.content?.supplier || {};
  const pickupRoute = rawOffer?.route_info?.pickup || {};
  const pricing = rawOffer?.pricing_info || {};
  const totalPrice = positiveNumber(pricing.drive_away_price) || positiveNumber(pricing.price);
  if (!totalPrice) return null;

  const name = String(vehicle.v_name || rawOffer.vehicle_name || "Rental car");
  const category = String(vehicle.group || vehicle.label || "Car");
  const supplier = String(supplierInfo.name || contentSupplier.name || "Supplier");
  const pickup = String(pickupRoute.address || supplierInfo.address || rawOffer.pickup_location || body.location || "Pickup location");
  const vehicleCode = String(vehicle.sipp || vehicle.sipp_code || rawOffer.sipp_code || "");
  const vehicleId = String(vehicle.v_id || rawOffer.vehicle_id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(vehicleId)) return null;
  const matchParts = [name, category, supplier, pickup];
  if (body.differentDropoff) matchParts.push(String(body.dropOffLocation || body.dropOffId || ""));
  const matchKey = matchParts.join("|").toLowerCase();
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
    discountLabel: getDiscountLabel(rawOffer, totalPrice, originalPrice),
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
    pickupLocationType: normalizeDepotLocationType(pickupRoute.location_type),
    imageUrl: String(vehicle.image_url || vehicle.image_thumbnail_url || rawOffer.image_url || ""),
    vehicleId,
    fromCountry: market
  };
}

function normalizeDepotLocationType(value) {
  const type = String(value || "").trim().toUpperCase();
  return ["DOWNTOWN", "TRAINSTATION", "SHUTTLE_BUS", "IN_TERMINAL"].includes(type) ? type : "";
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
    .find((text) => /discount|price cut|%\s*off|save|mobile-only|genius|member price|special price/i.test(text));
  if (badge) return badge;

  if (!(originalPrice > currentPrice)) return "";
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

async function loadQuoteDetails(quote, config) {
  const query = new URLSearchParams({
    vehicleId: quote.vehicleId,
    searchKey: quote.searchKey,
    units: "metric"
  });
  const requests = [
    ["detail", `${config.endpoints.detail}?${query}`],
    ["packages", `${config.endpoints.packages}?${query}`],
    ["summary", `${config.endpoints.bookingSummary}?${query}`]
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

function normalizeBaseUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:") {
    throw new Error("RENTAL_API_BASE_URL must use HTTPS.");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

function endpointUrl(baseUrl, path) {
  const url = new URL(String(path), baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("Rental provider endpoints must use HTTPS.");
  }
  return url.href;
}

function normalizeCurrency(value) {
  const currency = String(value || "GBP").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "GBP";
}

function normalizeDriverAge(value) {
  const age = Number(value);
  if (!Number.isInteger(age) || age < 18 || age > 99) {
    throw new Error("Driver age must be between 18 and 99.");
  }
  return String(age);
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
