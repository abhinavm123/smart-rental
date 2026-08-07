const elements = {
  searchForm: document.querySelector("#searchForm"),
  location: document.querySelector("#locationInput"),
  locationSuggestions: document.querySelector("#locationSuggestions"),
  differentDropoff: document.querySelector("#differentDropoffInput"),
  dropoffLocationField: document.querySelector("#dropoffLocationField"),
  dropoffLocation: document.querySelector("#dropoffLocationInput"),
  dropoffLocationSuggestions: document.querySelector("#dropoffLocationSuggestions"),
  pickupDate: document.querySelector("#pickupDateInput"),
  pickupTime: document.querySelector("#pickupTimeInput"),
  returnDate: document.querySelector("#returnDateInput"),
  returnTime: document.querySelector("#returnTimeInput"),
  driverAge: document.querySelector("#driverAgeInput"),
  currency: document.querySelector("#currencyInput"),
  maxPrice: document.querySelector("#maxPriceInput"),
  vehicleSize: document.querySelector("#vehicleSizeInput"),
  transmission: document.querySelector("#transmissionInput"),
  supplierRating: document.querySelector("#supplierRatingInput"),
  features: [...document.querySelectorAll(".featureInput")],
  countries: [...document.querySelectorAll(".countryInput")],
  sort: document.querySelector("#sortInput"),
  fetchApi: document.querySelector("#fetchApiButton"),
  apiStatus: document.querySelector("#apiStatus"),
  resultCount: document.querySelector("#resultCount"),
  insight: document.querySelector("#insightText"),
  sourceLabel: document.querySelector("#sourceLabel"),
  tripLength: document.querySelector("#tripLengthLabel"),
  clearFilters: document.querySelector("#clearFiltersButton"),
  savedOnly: document.querySelector("#savedOnlyButton"),
  listings: document.querySelector("#listings"),
  emptyState: document.querySelector("#emptyState"),
  detailDialog: document.querySelector("#detailDialog"),
  detailTitle: document.querySelector("#detailTitle"),
  detailEyebrow: document.querySelector("#detailEyebrow"),
  detailBody: document.querySelector("#detailBody"),
  detailClose: document.querySelector("#detailCloseButton")
};

const state = {
  cars: [],
  currency: elements.currency.value,
  source: "Ready",
  hasSearched: false,
  savedOnly: false,
  selectedLocation: null,
  selectedDropoffLocation: null,
  suggestions: [],
  dropoffSuggestions: [],
  suggestionCache: new Map(),
  activeSuggestion: -1,
  dropoffActiveSuggestion: -1,
  suggestionAbort: null,
  dropoffSuggestionAbort: null,
  detailCache: new Map(),
  detailAbort: null,
  activeDetailId: "",
  saved: loadSavedCars()
};

const suggestionTimers = { pickup: 0, dropoff: 0 };

const vehicleSizeLabels = {
  mini_economy: "Mini / Economy",
  compact: "Compact",
  intermediate_standard: "Intermediate / Standard",
  fullsize: "Full-size",
  suv_crossover: "SUV / Crossover",
  van: "People carrier / Van",
  premium_luxury: "Premium / Luxury"
};

setDefaultDates();
syncDifferentDropoffField();
render();

function setDefaultDates() {
  const today = new Date();
  const pickup = addDays(today, 7);
  const dropoff = addDays(today, 11);

  elements.pickupDate.min = toDateInput(today);
  elements.returnDate.min = toDateInput(addDays(today, 1));
  elements.pickupDate.value = toDateInput(pickup);
  elements.returnDate.value = toDateInput(dropoff);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function toDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getFilters() {
  const maxPrice = Number(elements.maxPrice.value);

  return {
    maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : Infinity,
    vehicleSize: elements.vehicleSize.value,
    transmission: elements.transmission.value,
    minimumSupplierRating: Number(elements.supplierRating.value) || 0,
    features: elements.features.filter((input) => input.checked).map((input) => input.value)
  };
}

function getSearchRequest() {
  const request = {
    location: elements.location.value.trim(),
    pickupDate: elements.pickupDate.value,
    pickupTime: elements.pickupTime.value,
    returnDate: elements.returnDate.value,
    returnTime: elements.returnTime.value,
    driverAge: elements.driverAge.value === "" ? null : Number(elements.driverAge.value),
    currency: elements.currency.value,
    fromCountries: getSelectedCountries()
  };

  if (state.selectedLocation) {
    request.location = state.selectedLocation.label;
    request.pickupId = state.selectedLocation.id;
  }

  if (elements.differentDropoff.checked) {
    request.differentDropoff = true;
    request.dropOffLocation = elements.dropoffLocation.value.trim();
    if (state.selectedDropoffLocation) {
      request.dropOffLocation = state.selectedDropoffLocation.label;
      request.dropOffId = state.selectedDropoffLocation.id;
    }
  }

  return request;
}

function validateSearch(request) {
  if (!request.location) return "Choose a pickup location.";
  if (request.differentDropoff && !request.dropOffLocation) return "Choose a drop-off location.";
  if (request.driverAge === null) return "Enter the driver's age.";
  if (!Number.isInteger(request.driverAge) || request.driverAge < 18 || request.driverAge > 99) {
    return "Driver age must be between 18 and 99.";
  }
  if (!request.pickupDate || !request.returnDate) return "Choose pickup and return dates.";
  if (!request.fromCountries.length) return "Choose at least one renter country to compare.";

  const start = new Date(`${request.pickupDate}T${request.pickupTime || "00:00"}`);
  const end = new Date(`${request.returnDate}T${request.returnTime || "00:00"}`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return "Choose valid trip dates.";
  if (end <= start) return "Return must be after pickup.";

  return "";
}

function tripDays() {
  const start = new Date(`${elements.pickupDate.value}T${elements.pickupTime.value || "00:00"}`);
  const end = new Date(`${elements.returnDate.value}T${elements.returnTime.value || "00:00"}`);
  const diff = Math.ceil((end - start) / 86400000);
  return Math.max(1, diff || 1);
}

function money(value, currency = state.currency) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

function matchesCar(car, filters) {
  const featureMatch = filters.features.every((feature) => hasFeature(car, feature));
  const sizeMatch = filters.vehicleSize === "any" || car.vehicleSize === filters.vehicleSize;
  const transmissionMatch = filters.transmission === "any" || car.transmission === filters.transmission;
  const ratingMatch = car.supplierRating >= filters.minimumSupplierRating;

  return (
    car.totalPrice <= filters.maxPrice &&
    sizeMatch &&
    transmissionMatch &&
    ratingMatch &&
    featureMatch
  );
}

function sortCars(a, b) {
  const sort = elements.sort.value;
  if (sort === "total") return a.totalPrice - b.totalPrice;
  if (sort === "daily") return a.dailyPrice - b.dailyPrice;
  if (sort === "rating") return b.supplierRating - a.supplierRating;
  return dealScore(a) - dealScore(b);
}

function dealScore(car) {
  const mileagePenalty = hasFeature(car, "unlimited mileage") ? 0 : 35;
  const cancellationPenalty = car.cancellation === "free cancellation" ? 0 : 20;
  const ratingCredit = car.supplierRating * 4;
  return car.totalPrice + mileagePenalty + cancellationPenalty - ratingCredit;
}

function hasFeature(car, feature) {
  if (feature === "unlimited mileage" || feature === "unlimited miles") {
    return String(car.mileage || "").toLowerCase().includes("unlimited");
  }

  if (feature === "free cancellation") {
    return car.cancellation === "free cancellation";
  }

  return false;
}

function render() {
  const filters = getFilters();
  const sourceCars = state.savedOnly ? getSavedCarsForDisplay() : state.cars;
  const filtered = (
    state.savedOnly
      ? sourceCars
      : sourceCars.filter((car) => matchesCar(car, filters))
  ).sort(sortCars);

  elements.listings.innerHTML = filtered.map(renderCard).join("");
  const savedCount = countSavedCars();
  elements.savedOnly.textContent = savedCount
    ? `Saved only (${savedCount})`
    : "Saved only";
  renderHeader(filtered);
  renderEmptyState(filtered);
  return filtered;
}

function renderHeader(filtered) {
  const best = filtered[0];
  const countLabel = `${filtered.length} ${filtered.length === 1 ? "car" : "cars"}`;
  const days = tripDays();

  elements.resultCount.textContent = countLabel;
  elements.sourceLabel.textContent = state.savedOnly ? "Saved cars" : state.source;
  elements.tripLength.textContent = `${days} ${days === 1 ? "day" : "days"}`;
  elements.clearFilters.hidden = !state.hasSearched || !hasActiveFilters();

  if (best) {
    elements.insight.textContent = `${best.name} from ${best.supplier} is the cheapest visible match at ${money(best.totalPrice, best.currency)} total.`;
    return;
  }

  elements.insight.textContent = state.hasSearched
    ? "No cars match the current filters. Try removing a filter or raising the max total."
    : "Choose a suggested pickup place, trip dates, then search live prices.";
}

function renderEmptyState(filtered) {
  elements.emptyState.hidden = filtered.length > 0;

  if (state.savedOnly) {
    elements.emptyState.textContent = countSavedCars()
      ? "The saved car information could not be loaded."
      : "No saved cars yet. Use Save on a result to keep it here.";
    return;
  }

  if (!state.hasSearched) {
    elements.emptyState.textContent = "Search a pickup location to see live rental cars.";
    return;
  }

  elements.emptyState.textContent = state.cars.length
    ? "No cars match these filters. Clear the filters to show the live cars returned by the API."
    : "No rental cars were returned for this search.";
}

function renderCard(car) {
  const saved = state.saved.has(car.id);

  return `
    <article class="listing-card" data-id="${escapeHtml(car.id)}">
      <div class="photo">${renderMedia(car)}</div>
      <div class="listing-main">
        <div class="card-title-row">
          <h3>${escapeHtml(car.name)}</h3>
        </div>
        ${car.similarLabel ? `<p class="vehicle-subtitle">${escapeHtml(car.similarLabel)}</p>` : ""}
        ${renderProvider(car)}
        ${renderRentalRoute(car)}
        <div class="chips">
          <span class="chip">${escapeHtml(getVehicleSizeLabel(car.vehicleSize))}</span>
          <span class="chip">${escapeHtml(formatTerm(car.transmission))}</span>
          <span class="chip">${escapeHtml(formatTerm(car.mileage))}</span>
          <span class="chip">${escapeHtml(formatTerm(car.cancellation))}</span>
          <span class="chip price-country">Priced for ${escapeHtml(formatCountry(car.fromCountry))}</span>
        </div>
        ${renderCountryComparison(car)}
        ${renderSavedFreshness(car)}
      </div>
      <div class="listing-side">
        <div>
          ${renderPriceCut(car)}
          <div class="rent">${money(car.totalPrice, car.currency)}</div>
          <div class="deal-score">${money(car.dailyPrice, car.currency)} per day</div>
          ${renderAccountDiscountNote()}
        </div>
        <div class="card-actions">
          ${renderBookingButton(car)}
          <button class="details-button" type="button" data-detail="${escapeHtml(car.id)}">${car.quoteId ? "Review live quote" : "Review terms"}</button>
          <button class="save-button" type="button" aria-pressed="${saved}" data-save="${escapeHtml(car.id)}">${saved ? "Saved" : "Save"}</button>
        </div>
      </div>
    </article>
  `;
}

function renderRentalRoute(car) {
  const dropoff = car.searchRequest?.differentDropoff
    ? car.dropoff || car.searchRequest.dropOffLocation
    : "";
  if (!dropoff) {
    return `<p class="address">${escapeHtml(car.category)} &middot; ${escapeHtml(car.pickup)}</p>`;
  }

  return `
    <p class="address">${escapeHtml(car.category)}</p>
    <p class="rental-route">
      <span><strong>Pick-up:</strong> ${escapeHtml(car.pickup)}</span>
      <span aria-hidden="true">&rarr;</span>
      <span><strong>Drop-off:</strong> ${escapeHtml(dropoff)}</span>
    </p>
  `;
}

function renderBookingButton(car, className = "booking-button") {
  const bookingUrl = safeBookingUrl(car.bookingUrl);
  if (!bookingUrl || car.availability !== "active") return "";

  return `
    <a
      class="${className}"
      href="${escapeHtml(bookingUrl)}"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View this ${escapeHtml(formatCountry(car.fromCountry))}-priced quote on Booking.com"
    >Check latest price on Booking.com</a>
  `;
}

function renderAccountDiscountNote() {
  return `<p class="account-discount-note">Booking.com may apply further discounts to this vehicle based on your account level.</p>`;
}

function renderProvider(car) {
  const rating = car.supplierRating ? car.supplierRating.toFixed(1) : "";
  const ratingText = [rating, car.supplierRatingText, car.supplierReviewCount].filter(Boolean).join(" - ");

  return `
    <div class="provider-row">
      <div class="provider-logo">${renderSupplierLogo(car)}</div>
      <div class="provider-copy">
        <span>Rental provider</span>
        <strong>${escapeHtml(car.supplier || "Supplier")}</strong>
      </div>
      ${ratingText ? `<div class="provider-rating">${escapeHtml(ratingText)}</div>` : ""}
    </div>
  `;
}

function renderSupplierLogo(car) {
  if (car.supplierLogoUrl) {
    return `<img src="${escapeHtml(car.supplierLogoUrl)}" alt="${escapeHtml(car.supplier || "Supplier")} logo" loading="lazy">`;
  }

  return `<span>${escapeHtml(getInitials(car.supplier || "Supplier"))}</span>`;
}

function renderMedia(car) {
  if (car.imageUrl) {
    return `<img src="${escapeHtml(car.imageUrl)}" alt="" loading="lazy">`;
  }

  return `
    <svg viewBox="0 0 112 104" aria-hidden="true" focusable="false">
      <rect width="112" height="104" fill="#e8f0ed"></rect>
      <path d="M20 62 L31 42 H76 L92 62 Z" fill="#28715f"></path>
      <path d="M34 46 H52 V60 H26 Z" fill="#f5c768" opacity=".92"></path>
      <path d="M56 46 H74 L86 60 H56 Z" fill="#f5c768" opacity=".92"></path>
      <rect x="14" y="58" width="86" height="22" rx="8" fill="#28715f"></rect>
      <circle cx="34" cy="80" r="8" fill="#24322e"></circle>
      <circle cx="78" cy="80" r="8" fill="#24322e"></circle>
      <circle cx="34" cy="80" r="3" fill="#ffffff"></circle>
      <circle cx="78" cy="80" r="3" fill="#ffffff"></circle>
    </svg>
  `;
}

async function fetchLiveCars() {
  const request = getSearchRequest();
  const validationError = validateSearch(request);

  if (validationError) {
    setStatus(validationError, "error");
    return;
  }

  const marketCount = request.fromCountries.length;
  setStatus(`Searching live rental cars for ${marketCount} renter ${marketCount === 1 ? "market" : "markets"}...`, "loading");
  elements.fetchApi.disabled = true;

  try {
    const response = await fetch("/api/cars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Live provider returned ${response.status}`);

    const offers = Array.isArray(payload.offers) ? payload.offers : [];
    const searchRequest = normalizeSearchContext(request);
    const checkedAt = new Date().toISOString();
    const cars = offers
      .map((offer, index) => normalizeCar({
        ...offer,
        searchRequest,
        lastCheckedAt: checkedAt,
        availability: "active"
      }, index))
      .filter((car) => car.totalPrice > 0);

    state.cars = cars;
    refreshSavedCars(cars);
    state.currency = request.currency;
    state.source = getSourceLabel(payload);
    state.hasSearched = true;
    state.detailCache.clear();
    state.detailAbort?.abort();
    state.detailAbort = null;
    state.activeDetailId = "";

    const visibleCars = render();
    setStatus(
      getSearchStatus(
        cars.length,
        visibleCars.length,
        request.differentDropoff
          ? `${request.location} to ${request.dropOffLocation}`
          : request.location
      ),
      cars.length && visibleCars.length ? "success" : "error"
    );
    scrollToResults();
  } catch (error) {
    state.cars = [];
    state.source = "Unavailable";
    state.hasSearched = true;
    state.detailCache.clear();
    setStatus(error.message, "error");
    render();
  } finally {
    elements.fetchApi.disabled = false;
  }
}

function normalizeCar(item, index) {
  const name = String(item?.name || "Rental car");
  const category = String(item?.category || "Car");
  const vehicleCode = String(item?.vehicleCode || "");
  const searchRequest = normalizeSearchContext(item?.searchRequest);
  return {
    ...item,
    id: String(item?.id || `car-${index}`),
    name,
    category,
    similarLabel: String(item?.similarLabel || ""),
    vehicleSize: classifyVehicleSize({ name, category, code: vehicleCode }),
    supplier: String(item?.supplier || "Supplier"),
    supplierLogoUrl: safeUrl(item?.supplierLogoUrl),
    supplierRating: Number(item?.supplierRating) || 0,
    supplierRatingText: String(item?.supplierRatingText || ""),
    supplierReviewCount: String(item?.supplierReviewCount || ""),
    totalPrice: Number(item?.totalPrice) || 0,
    currency: /^[A-Z]{3}$/.test(String(item?.currency || "").toUpperCase())
      ? String(item.currency).toUpperCase()
      : elements.currency.value,
    originalPrice: Number(item?.originalPrice) > Number(item?.totalPrice)
      ? Number(item.originalPrice)
      : 0,
    discountLabel: String(item?.discountLabel || ""),
    dailyPrice: Number(item?.dailyPrice) || 0,
    transmission: normalizeTransmission(item?.transmission),
    fuel: String(item?.fuel || "check terms").toLowerCase(),
    mileage: normalizeMileage(item?.mileage),
    cancellation: normalizeCancellation(item?.cancellation),
    pickup: String(item?.pickup || elements.location.value.trim() || "Pickup"),
    dropoff: String(item?.dropoff || searchRequest?.dropOffLocation || ""),
    imageUrl: safeUrl(item?.imageUrl),
    bookingUrl: safeBookingUrl(item?.bookingUrl),
    knownFees: Array.isArray(item?.knownFees) ? item.knownFees : [],
    priceComparison: item?.priceComparison || null,
    searchRequest,
    lastCheckedAt: normalizeTimestamp(item?.lastCheckedAt),
    previousPrice: Number(item?.previousPrice) > 0 ? Number(item.previousPrice) : 0,
    priceChange: Number.isFinite(Number(item?.priceChange)) ? Number(item.priceChange) : 0,
    priceChangedAt: normalizeTimestamp(item?.priceChangedAt),
    availability: ["active", "unavailable", "expired"].includes(item?.availability)
      ? item.availability
      : "active"
  };
}

function normalizeSearchContext(value) {
  if (!value || typeof value !== "object") return null;
  const pickupDate = String(value.pickupDate || "");
  const returnDate = String(value.returnDate || "");
  const pickupTime = String(value.pickupTime || "");
  const returnTime = String(value.returnTime || "");
  const driverAge = Number(value.driverAge);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)
    || !/^\d{4}-\d{2}-\d{2}$/.test(returnDate)
    || !/^\d{2}:\d{2}$/.test(pickupTime)
    || !/^\d{2}:\d{2}$/.test(returnTime)
    || !Number.isInteger(driverAge)
    || driverAge < 18
    || driverAge > 99
  ) {
    return null;
  }

  return {
    location: String(value.location || ""),
    pickupId: String(value.pickupId || ""),
    differentDropoff: Boolean(value.differentDropoff),
    dropOffLocation: value.differentDropoff ? String(value.dropOffLocation || "") : "",
    dropOffId: value.differentDropoff ? String(value.dropOffId || "") : "",
    driverAge,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    currency: /^[A-Z]{3}$/.test(String(value.currency || "").toUpperCase())
      ? String(value.currency).toUpperCase()
      : "GBP",
    fromCountries: Array.isArray(value.fromCountries)
      ? value.fromCountries.map(String).slice(0, 7)
      : ["gb"]
  };
}

function normalizeTimestamp(value) {
  const timestamp = new Date(String(value || ""));
  return Number.isNaN(timestamp.valueOf()) ? "" : timestamp.toISOString();
}

function renderCountryComparison(car) {
  const comparison = car.priceComparison;
  const countries = Array.isArray(comparison?.countriesChecked) ? comparison.countriesChecked : [];
  if (countries.length < 2) return "";

  const checkedCountries = countries.map(formatCountry).join(", ");
  const spread = Number(comparison.spread) || 0;

  if (spread <= 0) {
    return `<p class="country-comparison">Same price across ${escapeHtml(checkedCountries)}.</p>`;
  }

  return `<p class="country-comparison">Cheapest when priced for ${escapeHtml(formatCountry(car.fromCountry))}; saves ${escapeHtml(money(spread, car.currency))} vs the highest checked country.</p>`;
}

function renderPriceCut(car, className = "price-cut") {
  const hasBeforePrice = car.originalPrice > car.totalPrice;
  const label = car.discountLabel || (hasBeforePrice ? "Price cut" : "");
  if (!label) return "";

  return `
    <div class="${className}${hasBeforePrice ? "" : " price-badge-only"}">
      ${hasBeforePrice ? `<del aria-label="Original price ${escapeHtml(money(car.originalPrice, car.currency))}">${money(car.originalPrice, car.currency)}</del>` : ""}
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function renderSavedFreshness(car) {
  if (!state.savedOnly) return "";
  const checked = car.lastCheckedAt
    ? `Last checked ${formatCheckedTime(car.lastCheckedAt)}`
    : "Not yet rechecked";
  const label = {
    active: "Available",
    unavailable: "No longer available",
    expired: "Trip expired"
  }[car.availability] || "Status unknown";
  const priceChange = renderSavedPriceChange(car);

  return `
    <p class="saved-freshness" data-availability="${escapeHtml(car.availability)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(checked)}</span>
      ${priceChange}
    </p>
  `;
}

function renderSavedPriceChange(car) {
  if (car.availability !== "active" || !car.previousPrice || !car.priceChange) return "";
  const increased = car.priceChange > 0;
  const direction = increased ? "increased" : "decreased";
  return `
    <span class="saved-price-change" data-direction="${direction}">
      Price ${direction} by ${escapeHtml(money(Math.abs(car.priceChange), car.currency))}
      since the previous quote of ${escapeHtml(money(car.previousPrice, car.currency))}.
    </span>
  `;
}

function formatCheckedTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "previously";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function getSourceLabel(payload) {
  const countries = payload?.meta?.markets;
  if (Array.isArray(countries) && countries.length > 1) {
    return `Compared ${countries.map(formatCountry).join(", ")}`;
  }

  return "Live prices";
}

function normalizeTransmission(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("manual")) return "manual";
  if (text.includes("automatic")) return "automatic";
  return "check terms";
}

function normalizeMileage(value) {
  const text = String(value || "").trim();
  if (!text) return "check terms";
  return text.toLowerCase();
}

function normalizeCancellation(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "check terms";
  if (text.includes("free")) return "free cancellation";
  if (text.includes("cancel")) return "cancellation terms";
  return "check terms";
}

function formatTerm(value) {
  const text = String(value || "").trim();
  if (!text) return "Check terms";
  if (/^km$/i.test(text)) return "km";
  return text
    .split(/\s+/)
    .map((word) => (/^km$/i.test(word) ? "km" : `${word[0].toUpperCase()}${word.slice(1)}`))
    .join(" ");
}

function classifyVehicleSize(car) {
  const codeClass = classifyVehicleCode(car.code);
  if (codeClass) return codeClass;

  const text = `${car.category || ""} ${car.name || ""}`.toLowerCase();
  if (/\b(suv|crossover|4x4|sport utility|off road|off-road)\b/.test(text)) return "suv_crossover";
  if (/\b(van|minivan|people carrier|passenger van|mpv|monospace)\b/.test(text)) return "van";
  if (/\b(premium|luxury|executive|prestige)\b/.test(text)) return "premium_luxury";
  if (/\b(full[-\s]?size|large)\b/.test(text)) return "fullsize";
  if (/\b(intermediate|standard|mid[-\s]?size|midsize)\b/.test(text)) return "intermediate_standard";
  if (/\bcompact\b/.test(text)) return "compact";
  if (/\b(mini|economy|city|small)\b/.test(text)) return "mini_economy";
  return "intermediate_standard";
}

function classifyVehicleCode(code) {
  const value = String(code || "").trim().toUpperCase();
  if (!value) return "";

  const bodyType = value[1];
  if (["F", "G", "J"].includes(bodyType)) return "suv_crossover";
  if (["V", "M", "K"].includes(bodyType)) return "van";

  const category = value[0];
  if (["M", "N", "E", "H"].includes(category)) return "mini_economy";
  if (["C", "D"].includes(category)) return "compact";
  if (["I", "J", "S", "R"].includes(category)) return "intermediate_standard";
  if (["F", "G", "O"].includes(category)) return "fullsize";
  if (["P", "U", "L", "W"].includes(category)) return "premium_luxury";
  return "";
}

function getVehicleSizeLabel(value) {
  return vehicleSizeLabels[value] || "Vehicle size";
}

function getSearchStatus(totalCount, visibleCount, location) {
  if (!totalCount) return "No rental cars were returned for this search.";
  if (visibleCount === totalCount) return `${totalCount} live cars found for ${location}.`;
  if (!visibleCount) return `${totalCount} live cars found, but your current filters hide them. Clear filters to show them.`;
  return `${totalCount} live cars found. Showing ${visibleCount} that match your filters.`;
}

function getSelectedCountries() {
  return elements.countries
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function formatCountry(value) {
  const labels = {
    uk: "UK",
    gb: "UK",
    us: "US",
    it: "Italy",
    de: "Germany",
    fr: "France",
    es: "Spain",
    ca: "Canada"
  };

  return labels[String(value || "").toLowerCase()] || String(value || "").toUpperCase() || "Default";
}

function hasActiveFilters() {
  return (
    Boolean(elements.maxPrice.value) ||
    elements.vehicleSize.value !== "any" ||
    elements.transmission.value !== "any" ||
    elements.supplierRating.value !== "0" ||
    elements.features.some((input) => input.checked) ||
    state.savedOnly
  );
}

function clearResultFilters() {
  elements.maxPrice.value = "";
  elements.vehicleSize.value = "any";
  elements.transmission.value = "any";
  elements.supplierRating.value = "0";
  elements.features.forEach((input) => {
    input.checked = false;
  });
  state.savedOnly = false;
  elements.savedOnly.setAttribute("aria-pressed", "false");

  const visibleCars = render();
  if (state.hasSearched) {
    setStatus(`${visibleCars.length} live cars visible.`, visibleCars.length ? "success" : "error");
  }
}

function scrollToResults() {
  document.querySelector(".results-section")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function getLocationPicker(kind = "pickup") {
  return kind === "dropoff"
    ? {
        input: elements.dropoffLocation,
        list: elements.dropoffLocationSuggestions,
        selectedKey: "selectedDropoffLocation",
        suggestionsKey: "dropoffSuggestions",
        activeKey: "dropoffActiveSuggestion",
        abortKey: "dropoffSuggestionAbort"
      }
    : {
        input: elements.location,
        list: elements.locationSuggestions,
        selectedKey: "selectedLocation",
        suggestionsKey: "suggestions",
        activeKey: "activeSuggestion",
        abortKey: "suggestionAbort"
      };
}

async function loadLocationSuggestions(query, kind = "pickup") {
  const picker = getLocationPicker(kind);
  if (state[picker.abortKey]) state[picker.abortKey].abort();
  const cacheKey = query.toLowerCase();
  const cached = state.suggestionCache.get(cacheKey);
  if (cached) {
    state[picker.suggestionsKey] = cached;
    state[picker.activeKey] = -1;
    renderSuggestions(kind);
    return;
  }

  state[picker.abortKey] = new AbortController();

  showSuggestionMessage("Searching places...", kind);

  try {
    const response = await fetch(`/api/locations?q=${encodeURIComponent(query)}`, {
      signal: state[picker.abortKey].signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Location search failed.");
    if (picker.input.value.trim() !== query) return;

    state[picker.suggestionsKey] = Array.isArray(payload.suggestions) ? payload.suggestions : [];
    if (state.suggestionCache.size >= 30) {
      state.suggestionCache.delete(state.suggestionCache.keys().next().value);
    }
    state.suggestionCache.set(cacheKey, state[picker.suggestionsKey]);
    state[picker.activeKey] = -1;
    renderSuggestions(kind);
  } catch (error) {
    if (error.name === "AbortError") return;
    showSuggestionMessage("No suggestions available.", kind);
  }
}

function renderSuggestions(kind = "pickup") {
  const picker = getLocationPicker(kind);
  const suggestions = state[picker.suggestionsKey];
  if (!suggestions.length) {
    showSuggestionMessage("No suggested places found.", kind);
    return;
  }

  picker.list.innerHTML = suggestions.map((suggestion, index) => `
    <button
      class="suggestion-option"
      type="button"
      role="option"
      aria-selected="${index === state[picker.activeKey]}"
      data-suggestion-index="${index}"
      data-location-kind="${kind}"
    >
      <span>${escapeHtml(suggestion.label)}</span>
      ${suggestion.secondary ? `<small>${escapeHtml(suggestion.secondary)}</small>` : ""}
    </button>
  `).join("");
  showSuggestions(kind);
}

function showSuggestionMessage(message, kind = "pickup") {
  const picker = getLocationPicker(kind);
  picker.list.innerHTML = `<div class="suggestion-message">${escapeHtml(message)}</div>`;
  showSuggestions(kind);
}

function showSuggestions(kind = "pickup") {
  const picker = getLocationPicker(kind);
  picker.list.hidden = false;
  picker.input.setAttribute("aria-expanded", "true");
}

function hideSuggestions(kind = "pickup") {
  const picker = getLocationPicker(kind);
  picker.list.hidden = true;
  picker.input.setAttribute("aria-expanded", "false");
  state[picker.activeKey] = -1;
}

function chooseSuggestion(index, kind = "pickup") {
  const picker = getLocationPicker(kind);
  const suggestion = state[picker.suggestionsKey][index];
  if (!suggestion) return;

  state[picker.selectedKey] = suggestion;
  picker.input.value = suggestion.label;
  hideSuggestions(kind);
  setStatus(`${kind === "dropoff" ? "Drop-off" : "Pickup"} location selected. Search when your dates are ready.`, "success");
}

function moveSuggestion(direction, kind = "pickup") {
  const picker = getLocationPicker(kind);
  const suggestions = state[picker.suggestionsKey];
  if (picker.list.hidden || !suggestions.length) return;

  const last = suggestions.length - 1;
  state[picker.activeKey] = Math.min(last, Math.max(0, state[picker.activeKey] + direction));

  [...picker.list.querySelectorAll(".suggestion-option")].forEach((button, index) => {
    const active = index === state[picker.activeKey];
    button.setAttribute("aria-selected", String(active));
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

async function showCarDetails(id) {
  let car = findCarById(id);
  if (!car) return;

  state.activeDetailId = id;
  elements.detailTitle.textContent = car.name;
  elements.detailEyebrow.textContent = `${formatCountry(car.fromCountry)} price - ${car.supplier}`;
  const isSaved = state.saved.has(id);
  const initialStatus = isSaved
    ? car.searchRequest
      ? "refreshing"
      : "This car was saved before live rechecks were added. Run its original search and save it again."
    : car.quoteId ? "loading" : "";
  renderDetails(car, null, initialStatus);
  openDetails();

  if (isSaved) {
    if (!car.searchRequest) return;
    state.detailAbort?.abort();
    const refreshController = new AbortController();
    state.detailAbort = refreshController;

    try {
      car = await refreshSavedQuote(car, refreshController.signal);
    } catch (error) {
      if (error.name !== "AbortError" && state.activeDetailId === id) {
        renderDetails(findCarById(id) || car, null, error.message || "Unable to recheck this saved quote.");
      }
      return;
    } finally {
      if (state.detailAbort === refreshController) state.detailAbort = null;
    }

    if (state.activeDetailId !== id) return;
    elements.detailTitle.textContent = car.name;
    elements.detailEyebrow.textContent = `${formatCountry(car.fromCountry)} price - ${car.supplier}`;
    renderDetails(car, null, car.quoteId ? "loading" : "");
  }

  if (!car.quoteId) return;

  const cached = state.detailCache.get(car.quoteId);
  if (cached) {
    renderLiveDetailsIfActive(car, cached);
    return;
  }

  state.detailAbort?.abort();
  const controller = new AbortController();
  state.detailAbort = controller;

  try {
    const response = await fetch(`/api/quotes/${encodeURIComponent(car.quoteId)}`, {
      signal: controller.signal
    });
    const quote = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(quote.error || "Unable to load the live quote.");

    state.detailCache.set(car.quoteId, quote);
    renderLiveDetailsIfActive(car, quote);
  } catch (error) {
    if (error.name !== "AbortError" && state.activeDetailId === car.id) {
      renderDetails(car, null, error.message || "Unable to load the live quote.");
    }
  } finally {
    if (state.detailAbort === controller) state.detailAbort = null;
  }
}

function findCarById(id) {
  const savedCar = state.saved.get(id);
  if (savedCar) return normalizeCar(savedCar, 0);
  return state.cars.find((car) => car.id === id) || null;
}

async function refreshSavedQuote(savedCar, signal) {
  const context = savedCar.searchRequest;
  if (hasPickupPassed(context)) {
    updateSavedAvailability(savedCar, "expired");
    throw new Error("The pickup date for this saved quote has passed. The original quote is shown below.");
  }

  const response = await fetch("/api/cars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(context),
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("The current availability could not be checked. The previously saved quote is shown below.");
  }

  const checkedAt = new Date().toISOString();
  const refreshed = (Array.isArray(payload.offers) ? payload.offers : [])
    .map((offer, index) => normalizeCar({
      ...offer,
      searchRequest: context,
      lastCheckedAt: checkedAt,
      availability: "active"
    }, index))
    .find((offer) => offer.id === savedCar.id);

  if (!refreshed) {
    updateSavedAvailability(savedCar, "unavailable", checkedAt);
    throw new Error("This car is no longer available for the saved trip. The original quote is shown below.");
  }

  refreshed.previousPrice = savedCar.totalPrice;
  refreshed.priceChange = refreshed.totalPrice - savedCar.totalPrice;
  refreshed.priceChangedAt = refreshed.priceChange ? checkedAt : "";
  state.saved.set(savedCar.id, createSavedCar(refreshed));
  persistSavedCars();
  if (refreshed.quoteId) state.detailCache.delete(refreshed.quoteId);
  if (state.savedOnly) render();
  return refreshed;
}

function hasPickupPassed(context) {
  const pickup = new Date(`${context.pickupDate}T${context.pickupTime}`);
  return Number.isNaN(pickup.valueOf()) || pickup <= new Date();
}

function updateSavedAvailability(car, availability, checkedAt = new Date().toISOString()) {
  const updated = normalizeCar({
    ...car,
    availability,
    lastCheckedAt: checkedAt
  }, 0);
  state.saved.set(car.id, createSavedCar(updated));
  persistSavedCars();
  if (state.savedOnly) render();
}

function renderLiveDetailsIfActive(car, quote) {
  if (state.activeDetailId !== car.id) return;
  elements.detailTitle.textContent = quote.vehicle?.title || car.name;
  renderDetails(car, quote);
}

function renderDetails(car, quote = null, status = "") {
  const specifications = quote?.vehicle?.specifications || {};
  const similarLabel = quote?.vehicle?.subtitle || car.similarLabel;
  const fallbackIncluded = [
    formatTerm(car.cancellation),
    formatTerm(car.mileage),
    specifications.transmission || formatTerm(car.transmission),
    specifications.fuelPolicy ? `Fuel policy: ${specifications.fuelPolicy}` : "",
    car.airConditioning ? "Air conditioning" : "Air conditioning not confirmed",
    specifications.seats || car.seats ? `${specifications.seats || car.seats} seats` : "",
    specifications.doors || car.doors ? `${specifications.doors || car.doors} doors` : ""
  ].filter(Boolean);
  const included = quote?.included?.length ? quote.included : fallbackIncluded;
  const pricingNotes = [
    quote?.price?.payWhen
      ? `Payment: ${quote.price.payWhen}`
      : car.payWhen ? `Payment: ${formatTerm(car.payWhen.replace(/_/g, " "))}` : "",
    quote?.price?.freeCancellation || "",
    car.basePrice && car.baseCurrency && car.baseCurrency !== state.currency
      ? `Provider base price: ${money(car.basePrice, car.baseCurrency)}`
      : "",
    !quote && car.fuel && car.fuel !== "check terms" ? `Fuel: ${formatTerm(car.fuel)}` : ""
  ].filter(Boolean);
  const supplier = quote?.supplier?.name || car.supplier;
  const supplierRating = Number(quote?.supplier?.rating || car.supplierRating);
  const rating = supplierRating ? supplierRating.toFixed(1) : "Not provided";
  const total = quote?.price?.totalDisplay || money(car.totalPrice, car.currency);

  elements.detailBody.innerHTML = `
    ${renderDetailStatus(status)}
    ${renderSavedQuoteNotice(car)}
    ${similarLabel ? `<p class="detail-vehicle-subtitle">${escapeHtml(similarLabel)}</p>` : ""}
    <div class="detail-grid">
      <section>
        <h4>${quote ? "Confirmed quote total" : "Search result total"}</h4>
        ${renderPriceCut(car, "detail-price-cut")}
        <p class="detail-price">${escapeHtml(total)}</p>
        <p>${money(car.dailyPrice, car.currency)} per day &middot; priced for ${escapeHtml(formatCountry(car.fromCountry))}</p>
        ${renderAccountDiscountNote()}
      </section>
      <section>
        <h4>Supplier</h4>
        <p>${escapeHtml(supplier)}</p>
        <p>Rating ${escapeHtml(rating)}</p>
        ${quote?.supplier?.locationType ? `<p>${escapeHtml(quote.supplier.locationType)}</p>` : ""}
      </section>
    </div>
    ${renderBookingHandoff(car)}
    ${renderQuoteTrip(quote)}
    ${renderDetailList("Included and vehicle", included)}
    ${renderDetailList("Price notes", pricingNotes)}
    ${quote ? renderQuoteFees(quote.fees) : renderKnownFees(car)}
    ${renderPriceBreakdown(quote?.priceBreakdown)}
    ${renderQuotePackages(quote?.packages)}
    ${renderDetailList("Important information", quote?.importantInfo || [])}
    ${renderQuoteWarnings(quote?.warnings)}
    ${renderTermsLink(quote?.termsUrl)}
    ${quote ? `<p class="detail-footnote">Booking.com performs the final live availability and price check before payment. If the result has changed, review the new price and terms before continuing.</p>` : ""}
  `;
}

function renderBookingHandoff(car) {
  const button = renderBookingButton(car, "detail-booking-button");
  if (!button) return "";

  return `
    <section class="booking-handoff">
      <div>
        <strong>Continue with this quote on Booking.com</strong>
        <p>Uses the same vehicle result, trip details, currency and ${escapeHtml(formatCountry(car.fromCountry))} renter market.</p>
      </div>
      ${button}
    </section>
  `;
}

function renderDetailStatus(status) {
  if (!status) return "";
  if (status === "refreshing") {
    return `<p class="detail-loading" role="status">Checking the saved car's current price and availability...</p>`;
  }
  if (status === "loading") {
    return `<p class="detail-loading" role="status">Loading the confirmed price, fees, packages and rental terms...</p>`;
  }
  return `<p class="detail-error" role="alert">${escapeHtml(status)}</p>`;
}

function renderSavedQuoteNotice(car) {
  if (!state.saved.has(car.id) || car.availability !== "active" || !car.previousPrice || !car.priceChange) {
    return "";
  }
  const increased = car.priceChange > 0;
  const direction = increased ? "increased" : "decreased";
  return `
    <section class="detail-price-change" data-direction="${direction}">
      <strong>Price ${direction} since the previous quote</strong>
      <span>
        Previous: ${escapeHtml(money(car.previousPrice, car.currency))}
        &middot; Current: ${escapeHtml(money(car.totalPrice, car.currency))}
        &middot; ${increased ? "+" : "-"}${escapeHtml(money(Math.abs(car.priceChange), car.currency))}
      </span>
    </section>
  `;
}

function renderQuoteTrip(quote) {
  const trip = quote?.trip;
  if (!trip || !Object.values(trip).some(Boolean)) return "";

  const pickup = [trip.pickupName, trip.pickupDateTime].filter(Boolean).join(" - ");
  const dropoff = [trip.dropoffName, trip.dropoffDateTime].filter(Boolean).join(" - ");
  return renderDetailList("Trip", [
    pickup ? `Pick-up: ${pickup}` : "",
    dropoff ? `Drop-off: ${dropoff}` : "",
    trip.duration ? `Duration: ${trip.duration}` : ""
  ].filter(Boolean));
}

function renderQuoteFees(fees = []) {
  const items = fees.map((fee) => {
    const amount = fee.amount && fee.currency
      ? `: ${moneyExact(fee.amount, fee.currency)}`
      : "";
    const treatment = fee.includedInPrice
      ? " (included in total)"
      : fee.alwaysPayable ? " (payable separately)" : "";
    return `${fee.name || "Fee"}${amount}${treatment}`;
  });
  return renderDetailList("Fees and deposits", items);
}

function renderPriceBreakdown(items = []) {
  if (!items.length) return "";
  return `
    <section class="detail-section">
      <h4>Price breakdown</h4>
      <div class="detail-breakdown">
        ${items.map((item) => `
          <div class="detail-breakdown-row">
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              ${item.subtitle ? `<small>${escapeHtml(item.subtitle)}</small>` : ""}
              ${item.details?.length ? `<small>${escapeHtml(item.details.map((detail) => `${detail.title}: ${detail.price}`).join(" · "))}</small>` : ""}
            </div>
            <strong>${escapeHtml(item.price)}</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderQuotePackages(packages = []) {
  if (!packages.length) return "";
  return `
    <section class="detail-section">
      <h4>Available protection packages</h4>
      <div class="detail-package-grid">
        ${packages.map((item) => `
          <article class="detail-package">
            <div class="detail-package-heading">
              <strong>${escapeHtml(item.title)}</strong>
              ${item.price ? `<span>${escapeHtml(item.price)}</span>` : ""}
            </div>
            ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
            ${item.highlights?.length ? `<ul>${item.highlights.map((highlight) => `<li>${escapeHtml(highlight)}</li>`).join("")}</ul>` : ""}
            ${renderPackageLinks(item)}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderPackageLinks(item) {
  const links = [
    [item.documentUrl, "View package document"],
    [item.informationUrl, "More package information"]
  ].filter(([url]) => safeUrl(url));
  if (!links.length) return "";

  return `<div class="detail-links">${links.map(([url, label]) =>
    `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
  ).join("")}</div>`;
}

function renderQuoteWarnings(warnings = []) {
  if (!warnings.length) return "";
  return `<p class="detail-warning">Some live sections were unavailable: ${escapeHtml(warnings.join("; "))}</p>`;
}

function renderTermsLink(url) {
  const safe = safeUrl(url);
  if (!safe) return "";
  return `
    <a class="detail-terms-link" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">
      View full rental terms
    </a>
  `;
}

function renderKnownFees(car) {
  const fees = car.knownFees
    .filter((fee) => fee && (fee.is_always_payable || String(fee.type || "").toUpperCase() === "DEPOSIT"))
    .slice(0, 8)
    .map((fee) => {
      const name = String(fee.type || "Fee").replace(/_/g, " ").toLowerCase();
      const amount = Number(fee.amount ?? fee.min_amount ?? fee.max_amount);
      const suffix = Number.isFinite(amount) && amount > 0
        ? `: ${money(amount, fee.currency || car.currency || state.currency)}`
        : ": see provider terms";
      return `${name}${suffix}`;
    });

  return renderDetailList("Fees and deposits", fees);
}

function renderDetailList(title, items) {
  if (!items.length) return "";
  return `
    <section class="detail-section">
      <h4>${escapeHtml(title)}</h4>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
  `;
}

function openDetails() {
  if (elements.detailDialog.open) return;
  if (typeof elements.detailDialog.showModal === "function") {
    elements.detailDialog.showModal();
  } else {
    elements.detailDialog.setAttribute("open", "");
  }
}

function getSavedCarsForDisplay() {
  return [...state.saved.entries()]
    .map(([, snapshot], index) => snapshot ? normalizeCar(snapshot, index) : null)
    .filter(Boolean);
}

function countSavedCars() {
  return [...state.saved.values()].filter(Boolean).length;
}

function refreshSavedCars(cars) {
  let changed = false;
  for (const car of cars) {
    if (!state.saved.has(car.id)) continue;
    const previous = state.saved.get(car.id);
    const refreshed = {
      ...car,
      previousPrice: previous?.totalPrice || 0,
      priceChange: previous?.totalPrice ? car.totalPrice - previous.totalPrice : 0,
      priceChangedAt: previous?.totalPrice && car.totalPrice !== previous.totalPrice
        ? car.lastCheckedAt
        : ""
    };
    state.saved.set(car.id, createSavedCar(refreshed));
    changed = true;
  }
  if (changed) persistSavedCars();
}

function toggleSaved(id) {
  const liveCar = state.cars.find((car) => car.id === id);
  const savedCar = state.saved.get(id);
  const carName = liveCar?.name || savedCar?.name || "Car";
  const removing = state.saved.has(id);

  if (removing) {
    state.saved.delete(id);
  } else if (liveCar) {
    state.saved.set(id, createSavedCar(liveCar));
  } else {
    return;
  }

  const persisted = persistSavedCars();
  render();
  setStatus(
    removing
      ? `${carName} removed from saved cars.`
      : persisted
        ? `${carName} saved. It will remain available after refreshing the page.`
        : `${carName} is saved for this tab, but browser storage is unavailable.`,
    persisted ? "success" : "error"
  );
}

function createSavedCar(car) {
  return {
    id: car.id,
    name: car.name,
    similarLabel: car.similarLabel,
    category: car.category,
    vehicleCode: car.vehicleCode,
    vehicleSize: car.vehicleSize,
    supplier: car.supplier,
    supplierLogoUrl: car.supplierLogoUrl,
    supplierRating: car.supplierRating,
    supplierRatingText: car.supplierRatingText,
    supplierReviewCount: car.supplierReviewCount,
    totalPrice: car.totalPrice,
    currency: car.currency,
    originalPrice: car.originalPrice,
    discountLabel: car.discountLabel,
    dailyPrice: car.dailyPrice,
    basePrice: car.basePrice,
    baseCurrency: car.baseCurrency,
    knownFees: car.knownFees,
    payWhen: car.payWhen,
    transmission: car.transmission,
    fuel: car.fuel,
    mileage: car.mileage,
    cancellation: car.cancellation,
    airConditioning: car.airConditioning,
    seats: car.seats,
    doors: car.doors,
    pickup: car.pickup,
    dropoff: car.dropoff,
    imageUrl: car.imageUrl,
    bookingUrl: car.bookingUrl,
    fromCountry: car.fromCountry,
    priceComparison: car.priceComparison,
    searchRequest: createSavedSearchContext(car),
    lastCheckedAt: car.lastCheckedAt,
    previousPrice: car.previousPrice,
    priceChange: car.priceChange,
    priceChangedAt: car.priceChangedAt,
    availability: car.availability
  };
}

function createSavedSearchContext(car) {
  const context = normalizeSearchContext(car.searchRequest);
  if (!context) return null;
  return {
    ...context,
    fromCountries: car.fromCountry ? [car.fromCountry] : context.fromCountries
  };
}

function persistSavedCars() {
  try {
    const saved = [...state.saved.values()].filter(Boolean);
    localStorage.setItem("savedCars", JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

function setStatus(message, type = "") {
  elements.apiStatus.textContent = message;
  elements.apiStatus.dataset.type = type;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function safeBookingUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "cars.booking.com" ? url.href : "";
  } catch {
    return "";
  }
}

function moneyExact(value, currency) {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(Number(value) || 0);
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function getInitials(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() || "")
    .join("") || "S";
}

function loadSavedCars() {
  try {
    const saved = JSON.parse(localStorage.getItem("savedCars") || "[]");
    const entries = Array.isArray(saved) ? saved : [];
    const result = new Map();

    for (const item of entries) {
      if (
        item
        && typeof item === "object"
        && item.id
        && item.name
        && Number(item.totalPrice) > 0
      ) {
        result.set(String(item.id), item);
      }
    }
    localStorage.setItem("savedCars", JSON.stringify([...result.values()]));
    return result;
  } catch {
    return new Map();
  }
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  fetchLiveCars();
});

function bindLocationPicker(kind) {
  const picker = getLocationPicker(kind);
  picker.input.addEventListener("input", () => {
    const query = picker.input.value.trim();
    state[picker.selectedKey] = state[picker.selectedKey]?.label === query
      ? state[picker.selectedKey]
      : null;

    hideSuggestions(kind === "pickup" ? "dropoff" : "pickup");
    clearTimeout(suggestionTimers[kind]);
    if (query.length < 2) {
      hideSuggestions(kind);
      return;
    }

    suggestionTimers[kind] = window.setTimeout(() => loadLocationSuggestions(query, kind), 260);
  });

  picker.input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSuggestion(1, kind);
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1, kind);
    }

    if (event.key === "Enter" && state[picker.activeKey] >= 0) {
      event.preventDefault();
      chooseSuggestion(state[picker.activeKey], kind);
    }

    if (event.key === "Escape") hideSuggestions(kind);
  });
}

bindLocationPicker("pickup");
bindLocationPicker("dropoff");

function syncDifferentDropoffField(focus = false) {
  const enabled = elements.differentDropoff.checked;
  elements.dropoffLocationField.hidden = !enabled;
  elements.dropoffLocation.disabled = !enabled;
  if (!enabled) {
    state.dropoffSuggestionAbort?.abort();
    hideSuggestions("dropoff");
  } else if (focus) {
    elements.dropoffLocation.focus();
  }
}

elements.differentDropoff.addEventListener("change", () => syncDifferentDropoffField(true));

[elements.pickupDate, elements.pickupTime, elements.returnDate, elements.returnTime].forEach((input) => {
  input.addEventListener("change", render);
});

elements.maxPrice.addEventListener("input", render);

[elements.vehicleSize, elements.transmission, elements.supplierRating, elements.sort, ...elements.features, ...elements.countries].forEach((input) => {
  input.addEventListener("change", render);
});

document.addEventListener("click", (event) => {
  const suggestionButton = event.target.closest("[data-suggestion-index]");
  const saveButton = event.target.closest("[data-save]");
  const detailButton = event.target.closest("[data-detail]");

  if (suggestionButton) {
    chooseSuggestion(
      Number(suggestionButton.dataset.suggestionIndex),
      suggestionButton.dataset.locationKind || "pickup"
    );
    return;
  }

  if (!event.target.closest(".location-field")) {
    hideSuggestions("pickup");
    hideSuggestions("dropoff");
  }
  if (saveButton) toggleSaved(saveButton.dataset.save);
  if (detailButton) showCarDetails(detailButton.dataset.detail);
});

elements.detailClose.addEventListener("click", () => elements.detailDialog.close());
elements.clearFilters.addEventListener("click", clearResultFilters);
elements.savedOnly.addEventListener("click", () => {
  state.savedOnly = !state.savedOnly;
  elements.savedOnly.setAttribute("aria-pressed", String(state.savedOnly));
  const visibleCars = render();
  if (state.savedOnly) {
    setStatus(
      `${visibleCars.length} saved ${visibleCars.length === 1 ? "car" : "cars"} shown from all searches.`,
      visibleCars.length ? "success" : ""
    );
  } else if (state.hasSearched) {
    setStatus(`${visibleCars.length} cars visible from the current search.`, visibleCars.length ? "success" : "error");
  } else {
    setStatus("Choose a location and search live prices.", "");
  }
});
