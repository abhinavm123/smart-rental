import assert from "node:assert/strict";
import test from "node:test";

import {
  combineMarketResults,
  createAppServer,
  normalizeMarket,
  normalizeProviderOffer,
  normalizeQuoteDetails
} from "./server.js";

const trip = {
  location: "New York",
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
  assert.match(await page.text(), /Smart Rental/);

  const envFile = await fetch(`${baseUrl}/.env`);
  assert.equal(envFile.status, 404);

  const adminPage = await fetch(`${baseUrl}/admin`);
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /Admin sign in/);

  const privateDashboard = await fetch(`${baseUrl}/api/admin/dashboard`);
  assert.equal(privateDashboard.status, 401);

  const invalidSearch = await fetch(`${baseUrl}/api/cars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(invalidSearch.status, 400);
  assert.deepEqual(await invalidSearch.json(), { error: "A pickup location is required." });
});

test("normalizes UK market aliases", () => {
  assert.equal(normalizeMarket("uk"), "gb");
  assert.equal(normalizeMarket("IT"), "it");
  assert.equal(normalizeMarket("invalid"), "");
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
  assert.equal(normalized.fromCountry, "gb");
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
  assert.equal(result.offers[0].priceComparison.countriesChecked.length, 3);
  assert.equal(result.offers[0].priceComparison.spread, 207.36 - 189.69);
  assert.equal(result.offers[0].matchKey, undefined);
  assert.equal(result.offers[0].vehicleId, undefined);
  assert.deepEqual(registeredQuote, {
    vehicleId: "vehicle-1",
    searchKey: "gb-key",
    market: "gb"
  });
  assert.deepEqual(result.meta.markets, ["us", "gb", "it"]);
  assert.equal(result.meta.sourceOfferCount, 3);
  assert.equal(result.meta.offerCount, 1);
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
