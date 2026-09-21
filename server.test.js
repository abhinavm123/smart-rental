import assert from "node:assert/strict";
import test from "node:test";

import {
  combineMarketResults,
  createAppServer,
  normalizeMarket,
  normalizeProviderOffer,
  normalizeQuoteDetails,
  settleWithConcurrency
} from "./server.js";
import {
  buildBookingUrl,
  createBookingCom18Config,
  searchCars
} from "./providers/booking-com18.js";
import { getRentalProvider, getRentalProviderIds } from "./providers/index.js";

const trip = {
  location: "New York",
  driverAge: 40,
  pickupDate: "2026-07-29",
  pickupTime: "10:00",
  returnDate: "2026-08-02",
  returnTime: "10:00",
  currency: "GBP"
};

function offer(price, baseCurrency, basePrice = price) {
  return {
    content: {
      badges: [{ text: "Free cancellation" }],
      supplier: {
        name: "Budget",
        imageUrl: "https://example.com/budget.png",
        rating: { average: "8.6", title: "Fabulous", subtitle: "20 reviews" }
      },
      vehicleSpecs: [
        { icon: "TRANSMISSION_AUTOMATIC", text: "Automatic" },
        { icon: "MILEAGE", text: "Unlimited mileage" }
      ]
    },
    vehicle_info: {
      v_id: "vehicle-1",
      v_name: "Kia Soul",
      group: "Compact",
      group_or_similar: "or similar",
      transmission: "Automatic",
      mileage: "Unlimited mileage",
      free_cancellation: 1,
      aircon: 1,
      seats: "5",
      doors: "4",
      image_url: "https://example.com/kia.png"
    },
    supplier_info: {
      name: "Budget",
      address: "Central New York"
    },
    route_info: {
      pickup: {
        address: "Central New York",
        location_type: "DOWNTOWN"
      }
    },
    pricing_info: {
      price,
      currency: "GBP",
      base_price: basePrice,
      base_currency: baseCurrency,
      pay_when: "PAY_NOW",
      fee_breakdown: {
        known_fees: [{ type: "DEPOSIT", min_amount: 300, max_amount: 300, currency: "USD" }]
      }
    }
  };
}

test("serves the app and validates search requests locally", async (context) => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Smart Rental/);
  assert.match(pageHtml, /supplierRatingInput/);
  assert.match(pageHtml, /<span>Car category<\/span>/);
  for (const category of ["Small", "Medium", "Large", "Estate", "Premium", "People carriers", "SUVs"]) {
    assert.match(pageHtml, new RegExp(`>${category}<\\/option>`));
  }
  assert.match(pageHtml, /id="pickupLocationTypeInput"/);
  for (const pickupType of ["Airport terminal or shuttle", "City centre", "Train station", "Shuttle bus", "In terminal"]) {
    assert.match(pageHtml, new RegExp(`>${pickupType}<\\/option>`));
  }
  assert.match(pageHtml, /id="driverAgeInput"[^>]*required/);
  const renterMarkets = [
    "gb", "us", "it", "de", "fr", "es", "ca"
  ];
  assert.equal((pageHtml.match(/class="countryInput"[^>]*checked/g) || []).length, renterMarkets.length);
  for (const market of renterMarkets) {
    assert.match(pageHtml, new RegExp(`class="countryInput"[^>]*value="${market}"[^>]*checked`));
  }
  assert.match(pageHtml, /id="selectAllMarketsButton"/);
  assert.match(pageHtml, /id="clearAllMarketsButton"/);

  const envFile = await fetch(`${baseUrl}/.env`);
  assert.equal(envFile.status, 404);

  const invalidSearch = await fetch(`${baseUrl}/api/cars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(invalidSearch.status, 400);
  assert.deepEqual(await invalidSearch.json(), { error: "A pickup location is required." });

  const missingDropoff = await fetch(`${baseUrl}/api/cars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...trip, differentDropoff: true })
  });
  assert.equal(missingDropoff.status, 400);
  assert.deepEqual(await missingDropoff.json(), {
    error: "A drop-off location is required when returning the car somewhere else."
  });

  const invalidDriverAge = await fetch(`${baseUrl}/api/cars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...trip, driverAge: 17 })
  });
  assert.equal(invalidDriverAge.status, 400);
  assert.deepEqual(await invalidDriverAge.json(), {
    error: "Driver age must be between 18 and 99."
  });

  const missingDriverAge = await fetch(`${baseUrl}/api/cars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...trip, driverAge: undefined })
  });
  assert.equal(missingDriverAge.status, 400);
  assert.deepEqual(await missingDriverAge.json(), {
    error: "Driver age is required."
  });
});

test("normalizes UK market aliases", () => {
  assert.equal(normalizeMarket("uk"), "gb");
  assert.equal(normalizeMarket("IT"), "it");
  assert.equal(normalizeMarket("invalid"), "");
});

test("limits simultaneous renter-market requests while preserving result order", async () => {
  let activeRequests = 0;
  let highestActiveCount = 0;
  const items = Array.from({ length: 12 }, (_, index) => index);
  const results = await settleWithConcurrency(items, 3, async (item) => {
    activeRequests += 1;
    highestActiveCount = Math.max(highestActiveCount, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeRequests -= 1;
    if (item === 5) throw new Error("market unavailable");
    return item * 2;
  });

  assert.equal(highestActiveCount, 3);
  assert.equal(results.length, items.length);
  assert.deepEqual(results[4], { status: "fulfilled", value: 8 });
  assert.equal(results[5].status, "rejected");
  assert.match(results[5].reason.message, /market unavailable/);
  assert.deepEqual(results[6], { status: "fulfilled", value: 12 });
});

test("normalizes a booking-com18 rental offer", () => {
  const discountedOffer = offer(189.69, "GBP");
  discountedOffer.pricing_info.drive_away_price_before = 215.56;
  discountedOffer.content.badges.unshift({ text: "12% discount applied" });

  const normalized = normalizeProviderOffer(discountedOffer, "gb", trip);
  assert.equal(normalized.name, "Kia Soul");
  assert.equal(normalized.similarLabel, "or similar Compact");
  assert.equal(normalized.supplier, "Budget");
  assert.equal(normalized.totalPrice, 189.69);
  assert.equal(normalized.currency, "GBP");
  assert.equal(normalized.originalPrice, 215.56);
  assert.equal(normalized.discountLabel, "12% discount applied");
  assert.equal(normalized.dailyPrice, 189.69 / 4);
  assert.equal(normalized.cancellation, "free cancellation");
  assert.equal(normalized.pickupLocationType, "DOWNTOWN");
  assert.equal(normalized.vehicleSize, "small");
  assert.equal(normalized.fromCountry, "gb");

  const suvOffer = offer(210, "GBP");
  suvOffer.vehicle_info.v_id = "suv-1";
  suvOffer.vehicle_info.v_name = "Cupra Formentor";
  suvOffer.vehicle_info.group = "Intermediate";
  suvOffer.vehicle_info.label = "Intermediate car with:";
  suvOffer.vehicle_info.group_or_similar = "or similar SUV";
  assert.equal(normalizeProviderOffer(suvOffer, "gb", trip).vehicleSize, "suvs");

  const largeOffer = offer(220, "GBP");
  largeOffer.vehicle_info.v_id = "large-1";
  largeOffer.vehicle_info.v_name = "Nissan Qashqai";
  largeOffer.vehicle_info.group = "Standard";
  largeOffer.vehicle_info.label = "Standard car with:";
  largeOffer.vehicle_info.group_or_similar = "or similar large car";
  assert.equal(normalizeProviderOffer(largeOffer, "gb", trip).vehicleSize, "large");

  const oneWay = normalizeProviderOffer(discountedOffer, "gb", {
    ...trip,
    differentDropoff: true,
    dropOffLocation: "Boston"
  });
  assert.notEqual(oneWay.id, normalized.id);

  const missingVehicleId = offer(189.69, "GBP");
  delete missingVehicleId.vehicle_info.v_id;
  assert.equal(normalizeProviderOffer(missingVehicleId, "gb", trip), null);

  const oneWayPrice = offer(108.56, "GBP");
  oneWayPrice.pricing_info.drive_away_price = 201.66;
  oneWayPrice.content.badges.unshift({ text: "Mobile-only price" });
  const normalizedOneWayPrice = normalizeProviderOffer(oneWayPrice, "gb", {
    ...trip,
    differentDropoff: true,
    dropOffLocation: "Seville"
  });
  assert.equal(normalizedOneWayPrice.totalPrice, 201.66);
  assert.equal(normalizedOneWayPrice.dailyPrice, 201.66 / 4);
  assert.equal(normalizedOneWayPrice.originalPrice, 0);
  assert.equal(normalizedOneWayPrice.discountLabel, "Mobile-only price");
});

test("matches offers across countries and keeps the cheapest market", () => {
  let registeredQuote;
  const result = combineMarketResults([
    { market: "us", payload: { data: { search_key: "us-key", search_results: [offer(207.36, "USD", 277.25)] } } },
    { market: "gb", payload: { data: { search_key: "gb-key", search_results: [offer(189.69, "GBP")] } } },
    { market: "it", payload: { data: { search_key: "it-key", search_results: [offer(205.61, "EUR", 241.04)] } } }
  ], [], trip, (quote) => {
    registeredQuote = quote;
    return "opaque-quote-id";
  });

  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].fromCountry, "gb");
  assert.equal(result.offers[0].totalPrice, 189.69);
  assert.equal(result.offers[0].quoteId, "opaque-quote-id");
  const bookingUrl = new URL(result.offers[0].bookingUrl);
  assert.equal(bookingUrl.hostname, "cars.booking.com");
  assert.equal(bookingUrl.searchParams.get("vehicleId"), "vehicle-1");
  assert.equal(bookingUrl.searchParams.get("cor"), "gb");
  assert.equal(bookingUrl.searchParams.get("prefcurrency"), "GBP");
  assert.equal(result.offers[0].priceComparison.countriesChecked.length, 3);
  assert.equal(result.offers[0].priceComparison.spread, 207.36 - 189.69);
  assert.equal(result.offers[0].matchKey, undefined);
  assert.equal(result.offers[0].vehicleId, undefined);
  assert.deepEqual(registeredQuote, {
    vehicleId: "vehicle-1",
    searchKey: "gb-key",
    market: "gb",
    providerId: "booking-com18"
  });
  assert.deepEqual(result.meta.markets, ["us", "gb", "it"]);
  assert.equal(result.meta.sourceOfferCount, 3);
  assert.equal(result.meta.offerCount, 1);
});

test("retains more than 250 offers so city depots are not discarded", () => {
  const offers = Array.from({ length: 300 }, (_, index) => {
    const item = offer(100 + index, "GBP");
    item.vehicle_info.v_id = `vehicle-${index}`;
    item.vehicle_info.v_name = `Car ${index}`;
    item.supplier_info.address = `Depot ${index}`;
    item.route_info.pickup.address = `Depot ${index}`;
    return item;
  });

  const result = combineMarketResults([
    { market: "gb", payload: { data: { search_key: "gb-key", search_results: offers } } }
  ], [], trip);

  assert.equal(result.meta.sourceOfferCount, 300);
  assert.equal(result.meta.offerCount, 300);
});

test("selects a rental provider and supports compatible endpoint overrides", () => {
  assert.deepEqual(getRentalProviderIds(), ["booking-com18"]);
  assert.equal(getRentalProvider().id, "booking-com18");
  assert.throws(
    () => getRentalProvider("not-installed"),
    /Unknown RENTAL_PROVIDER/
  );

  const config = createBookingCom18Config({
    RENTAL_API_KEY: "example-key",
    RENTAL_API_HOST: "cars.example.test",
    RENTAL_API_BASE_URL: "https://cars.example.test/api/",
    RENTAL_API_SEARCH_PATH: "search-rentals",
    RENTAL_API_AUTOCOMPLETE_PATH: "locations"
  });

  assert.equal(config.apiKey, "example-key");
  assert.equal(config.host, "cars.example.test");
  assert.equal(config.endpoints.search, "https://cars.example.test/api/search-rentals");
  assert.equal(config.endpoints.autocomplete, "https://cars.example.test/api/locations");
  assert.equal(
    config.endpoints.bookingSummary,
    "https://cars.example.test/car/booking-summary"
  );
});

test("builds country-specific Booking.com links from fresh quote context", () => {
  const pickupId = Buffer.from(JSON.stringify({
    latitude: "40.774200439453125",
    longitude: "-73.87190246582031"
  })).toString("base64");
  const context = {
    ...trip,
    driverAge: 25,
    location: "LaGuardia Airport",
    pickupId,
    pickupDate: "2026-08-04",
    pickupTime: "12:00",
    returnDate: "2026-08-06",
    returnTime: "12:00",
    currency: "USD"
  };

  const usUrl = new URL(buildBookingUrl({
    vehicleId: "785102596",
    market: "us",
    body: context
  }));
  assert.equal(usUrl.origin, "https://cars.booking.com");
  assert.equal(usUrl.pathname, "/search-results");
  assert.equal(usUrl.searchParams.get("vehicleInfo.vehicle.id"), "785102596");
  assert.equal(usUrl.searchParams.get("cor"), "us");
  assert.equal(usUrl.searchParams.get("prefcurrency"), "USD");
  assert.equal(usUrl.searchParams.get("driversAge"), "25");
  assert.equal(usUrl.searchParams.get("puDay"), "4");
  assert.equal(usUrl.searchParams.get("puMonth"), "8");
  assert.equal(usUrl.searchParams.get("coordinates"), "40.774200439453125,-73.87190246582031");

  for (const market of ["gb", "us", "it", "de", "fr", "es", "ca"]) {
    const marketUrl = new URL(buildBookingUrl({
      vehicleId: "785102596",
      market,
      body: context,
      config: { bookingAffiliateId: "123456" }
    }));
    assert.equal(marketUrl.searchParams.get("cor"), market);
    assert.equal(marketUrl.searchParams.get("aid"), "123456");
  }
  assert.equal(buildBookingUrl({ vehicleId: "", market: "us", body: context }), "");

  const dropOffId = Buffer.from(JSON.stringify({
    latitude: "40.6413111",
    longitude: "-73.7781391"
  })).toString("base64");
  const oneWayUrl = new URL(buildBookingUrl({
    vehicleId: "785102596",
    market: "gb",
    body: {
      ...context,
      differentDropoff: true,
      dropOffLocation: "John F. Kennedy International Airport",
      dropOffId
    }
  }));
  assert.equal(oneWayUrl.searchParams.get("locationName"), "LaGuardia Airport");
  assert.equal(oneWayUrl.searchParams.get("dropLocationName"), "John F. Kennedy International Airport");
  assert.equal(oneWayUrl.searchParams.get("coordinates"), "40.774200439453125,-73.87190246582031");
  assert.equal(oneWayUrl.searchParams.get("dropCoordinates"), "40.6413111,-73.7781391");
});

test("passes a separate drop-off ID to one-way rental searches", async (context) => {
  let requestedUrl = "";
  context.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ status: true, data: { search_results: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  const config = createBookingCom18Config({
    RENTAL_API_KEY: "example-key",
    RENTAL_API_HOST: "cars.example.test",
    RENTAL_API_BASE_URL: "https://cars.example.test"
  });
  await searchCars({
    pickupId: "pickup-id",
    dropOffId: "dropoff-id",
    body: trip,
    market: "gb",
    config
  });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/car/search");
  assert.equal(url.searchParams.get("pickUpId"), "pickup-id");
  assert.equal(url.searchParams.get("dropOffId"), "dropoff-id");
  assert.equal(url.searchParams.get("driverAge"), "40");
});

test("normalizes repaired detail, packages and booking-summary responses", () => {
  const detail = {
    data: {
      whatsIncluded: {
        items: [{ text: "Third-Party Liability (TPL)" }]
      },
      supplier: {
        locationType: "Airport terminal",
        imageUrl: "https://example.com/supplier.png",
        rating: 8.6
      },
      vehicle: {
        makeAndModel: "Ford Edge",
        carClass: "SUV",
        imageUrl: "https://example.com/edge.png",
        payWhenText: "Pay at pick-up",
        price: { display: { currency: "USD", value: 252.6 } },
        fees: {
          payableFees: [],
          otherFees: [{
            name: "DEPOSIT",
            displayPrice: { amount: 300, currency: "USD" },
            includedInPrice: false,
            alwaysPayable: true
          }]
        },
        specification: {
          transmission: "Automatic",
          fuelPolicy: "Full to full",
          mileage: "Unlimited",
          numberOfSeats: "5",
          numberOfDoors: "4",
          airConditioning: true
        }
      },
      content: {
        reviews: {
          supplier: {
            name: "Avis",
            rating: { average: "8.6", title: "Fabulous", subtitle: "20 reviews" }
          }
        }
      },
      importantInfo: {
        items: [{ text: "<b>Credit card:</b> required at pick-up." }]
      },
      links: {
        fullRentalTerms: {
          url: "https://cars.booking.com/terms/example"
        }
      }
    }
  };
  const packages = {
    data: {
      packages: [{
        id: "full-protection",
        content: {
          title: "Full Protection",
          description: "Extra protection",
          included: "Collision damage coverage",
          price: { displayPrice: "$24" }
        }
      }]
    }
  };
  const summary = {
    data: {
      content: {
        product: {
          vehicle: { title: "Ford Edge", subtitle: "or similar SUV" },
          pickUp: { name: "LaGuardia Airport", dateTime: "Tue, 04 Aug · 12:00" },
          dropOff: { name: "LaGuardia Airport", dateTime: "Thu, 06 Aug · 12:00" },
          duration: "2 days"
        },
        freeCancellation: "Free cancellation at any time",
        priceBreakdown: {
          sections: [{
            items: [
              { title: "Car rental price", price: "$215.12" },
              { title: "Taxes and charges", price: "$37.48" }
            ]
          }],
          total: { primaryPrice: { price: "$252.60" } }
        },
        footer: { title: "$252.60" }
      },
      metadata: { basketSignature: "must-not-reach-the-browser" }
    }
  };

  const quote = normalizeQuoteDetails(detail, packages, summary);
  assert.equal(quote.vehicle.title, "Ford Edge");
  assert.equal(quote.vehicle.specifications.transmission, "Automatic");
  assert.equal(quote.supplier.name, "Avis");
  assert.equal(quote.price.totalDisplay, "$252.60");
  assert.equal(quote.trip.duration, "2 days");
  assert.equal(quote.fees[0].name, "Deposit");
  assert.equal(quote.fees[0].amount, 300);
  assert.equal(quote.packages[0].title, "Full Protection");
  assert.deepEqual(quote.included, ["Third-Party Liability (TPL)"]);
  assert.deepEqual(quote.importantInfo, ["Credit card: required at pick-up."]);
  assert.equal(quote.termsUrl, "https://cars.booking.com/terms/example");
  assert.doesNotMatch(JSON.stringify(quote), /basketSignature|must-not-reach-the-browser/);
});
