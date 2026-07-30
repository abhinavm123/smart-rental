import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const loginWindowMs = 15 * 60 * 1000;
const maxLoginFailures = 5;
const maxEvents = 10_000;
const maxAuditEntries = 1_000;
const transactionCategories = new Set([
  "booking_commission",
  "affiliate_payout",
  "refund",
  "operating_cost",
  "api_cost",
  "other"
]);
const publicEventTypes = new Set([
  "car_saved",
  "car_unsaved",
  "saved_quote_active",
  "saved_quote_unavailable",
  "saved_quote_expired",
  "saved_quote_check_failed"
]);

export function createAdminService({
  dataFile,
  passwordProvider = () => process.env.ADMIN_PASSWORD || ""
}) {
  const sessions = new Map();
  const loginFailures = new Map();
  let writeQueue = Promise.resolve();

  async function readStore() {
    try {
      const parsed = JSON.parse(await readFile(dataFile, "utf8"));
      return {
        version: 1,
        transactions: Array.isArray(parsed?.transactions) ? parsed.transactions : [],
        events: Array.isArray(parsed?.events) ? parsed.events : [],
        audit: Array.isArray(parsed?.audit) ? parsed.audit : []
      };
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        return { version: 1, transactions: [], events: [], audit: [] };
      }
      throw error;
    }
  }

  async function updateStore(update) {
    let result;
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const store = await readStore();
      result = await update(store);
      await mkdir(dirname(dataFile), { recursive: true });
      await writeFile(dataFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    });
    await writeQueue;
    return result;
  }

  function login(password, clientId) {
    const expected = String(passwordProvider() || "");
    if (!expected) return { status: 503, error: "Admin access is not configured." };

    const now = Date.now();
    const recentFailures = (loginFailures.get(clientId) || [])
      .filter((timestamp) => now - timestamp < loginWindowMs);
    if (recentFailures.length >= maxLoginFailures) {
      return { status: 429, error: "Too many login attempts. Try again later." };
    }

    if (!safeEqual(String(password || ""), expected)) {
      recentFailures.push(now);
      loginFailures.set(clientId, recentFailures);
      return { status: 401, error: "Incorrect admin password." };
    }

    loginFailures.delete(clientId);
    pruneSessions(sessions, now);
    const token = randomBytes(32).toString("hex");
    const session = {
      csrfToken: randomBytes(24).toString("hex"),
      expiresAt: now + sessionLifetimeMs
    };
    sessions.set(token, session);
    recordAudit("login", clientId);
    return { status: 200, token, ...session };
  }

  function authenticate(request) {
    const token = readCookie(request.headers.cookie, "admin_session");
    const session = token ? sessions.get(token) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return null;
    }
    return { token, ...session };
  }

  function logout(token, clientId) {
    if (token) sessions.delete(token);
    recordAudit("logout", clientId);
  }

  async function getDashboard() {
    const store = await readStore();
    return buildAdminDashboard(store);
  }

  async function addTransaction(input, clientId) {
    const transaction = normalizeAdminTransaction(input);
    return updateStore((store) => {
      store.transactions.push(transaction);
      store.audit.push(createAuditEntry("transaction_added", clientId, transaction.id));
      trimStore(store);
      return transaction;
    });
  }

  async function deleteTransaction(id, clientId) {
    return updateStore((store) => {
      const index = store.transactions.findIndex((transaction) => transaction.id === id);
      if (index === -1) return false;
      store.transactions.splice(index, 1);
      store.audit.push(createAuditEntry("transaction_deleted", clientId, id));
      trimStore(store);
      return true;
    });
  }

  function recordEvent(type, metadata = {}) {
    if (!isEventType(type)) return Promise.resolve(false);
    return updateStore((store) => {
      store.events.push({
        id: randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        metadata: sanitizeEventMetadata(metadata)
      });
      trimStore(store);
      return true;
    }).catch(() => false);
  }

  function recordPublicEvent(type, metadata = {}) {
    if (!publicEventTypes.has(type)) return false;
    recordEvent(type, metadata);
    return true;
  }

  function recordAudit(action, clientId, targetId = "") {
    updateStore((store) => {
      store.audit.push(createAuditEntry(action, clientId, targetId));
      trimStore(store);
    }).catch(() => {});
  }

  return {
    addTransaction,
    authenticate,
    deleteTransaction,
    getDashboard,
    login,
    logout,
    recordEvent,
    recordPublicEvent
  };
}

export function normalizeAdminTransaction(input, now = new Date()) {
  const date = String(input?.date || "");
  const direction = String(input?.direction || "");
  const category = String(input?.category || "");
  const status = String(input?.status || "");
  const currency = String(input?.currency || "").toUpperCase();
  const amount = Number(input?.amount);
  const grossBookingValue = Number(input?.grossBookingValue || 0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("A valid transaction date is required.");
  if (!["inflow", "outflow"].includes(direction)) throw new Error("Choose inflow or outflow.");
  if (!transactionCategories.has(category)) throw new Error("Choose a valid transaction category.");
  if (!["pending", "settled", "cancelled"].includes(status)) throw new Error("Choose a valid status.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Use a valid three-letter currency.");
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new Error("Enter an amount greater than zero.");
  }
  if (!Number.isFinite(grossBookingValue) || grossBookingValue < 0 || grossBookingValue > 1_000_000_000) {
    throw new Error("Gross booking value must be zero or greater.");
  }

  return {
    id: randomUUID(),
    date,
    direction,
    category,
    status,
    amount: roundMoney(amount),
    currency,
    grossBookingValue: roundMoney(grossBookingValue),
    reference: cleanText(input?.reference, 80),
    notes: cleanText(input?.notes, 300),
    createdAt: now.toISOString()
  };
}

export function buildAdminDashboard(store, now = new Date()) {
  const transactions = [...(store?.transactions || [])]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const events = Array.isArray(store?.events) ? store.events : [];
  const cutoff30Days = now.valueOf() - 30 * 86_400_000;
  const recentEvents = events.filter((event) => new Date(event.timestamp).valueOf() >= cutoff30Days);

  return {
    generatedAt: now.toISOString(),
    cashflow: summarizeCashflow(transactions),
    activity: summarizeActivity(recentEvents, now),
    transactions: transactions.slice(0, 250),
    audit: [...(store?.audit || [])].slice(-50).reverse()
  };
}

function summarizeCashflow(transactions) {
  const currencies = new Map();
  for (const transaction of transactions) {
    if (transaction.status === "cancelled") continue;
    const summary = currencies.get(transaction.currency) || {
      currency: transaction.currency,
      cashIn: 0,
      cashOut: 0,
      net: 0,
      pending: 0,
      grossBookingValue: 0,
      transactionCount: 0
    };
    const signedAmount = transaction.direction === "inflow" ? transaction.amount : -transaction.amount;
    if (transaction.status === "settled") {
      if (transaction.direction === "inflow") summary.cashIn += transaction.amount;
      else summary.cashOut += transaction.amount;
      summary.net += signedAmount;
    } else {
      summary.pending += signedAmount;
    }
    summary.grossBookingValue += Number(transaction.grossBookingValue) || 0;
    summary.transactionCount += 1;
    currencies.set(transaction.currency, summary);
  }
  return [...currencies.values()]
    .map((summary) => Object.fromEntries(
      Object.entries(summary).map(([key, value]) => [
        key,
        typeof value === "number" ? roundMoney(value) : value
      ])
    ))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function summarizeActivity(events, now) {
  const counts = {};
  const locations = new Map();
  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
    if (event.type === "search_completed" && event.metadata?.location) {
      const location = event.metadata.location;
      locations.set(location, (locations.get(location) || 0) + 1);
    }
  }

  const daily = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const next = date.valueOf() + 86_400_000;
    const dayEvents = events.filter((event) => {
      const timestamp = new Date(event.timestamp).valueOf();
      return timestamp >= date.valueOf() && timestamp < next;
    });
    daily.push({
      date: key,
      searches: dayEvents.filter((event) => event.type === "search_completed").length,
      quoteReviews: dayEvents.filter((event) => event.type === "quote_reviewed").length
    });
  }

  return {
    periodDays: 30,
    searches: counts.search_completed || 0,
    searchFailures: counts.search_failed || 0,
    offersReturned: events
      .filter((event) => event.type === "search_completed")
      .reduce((total, event) => total + (Number(event.metadata?.offers) || 0), 0),
    quoteReviews: counts.quote_reviewed || 0,
    quoteFailures: counts.quote_review_failed || 0,
    carsSaved: counts.car_saved || 0,
    savedQuoteChecks: (counts.saved_quote_active || 0)
      + (counts.saved_quote_unavailable || 0)
      + (counts.saved_quote_expired || 0)
      + (counts.saved_quote_check_failed || 0),
    unavailableSavedQuotes: counts.saved_quote_unavailable || 0,
    topLocations: [...locations.entries()]
      .map(([location, searches]) => ({ location, searches }))
      .sort((a, b) => b.searches - a.searches)
      .slice(0, 8),
    daily
  };
}

function sanitizeEventMetadata(metadata) {
  return {
    ...(metadata.location ? { location: cleanText(metadata.location, 80) } : {}),
    ...(Number.isFinite(Number(metadata.markets)) ? { markets: Math.max(0, Math.min(6, Number(metadata.markets))) } : {}),
    ...(Number.isFinite(Number(metadata.offers)) ? { offers: Math.max(0, Math.min(10_000, Number(metadata.offers))) } : {}),
    ...(Number.isFinite(Number(metadata.failures)) ? { failures: Math.max(0, Math.min(100, Number(metadata.failures))) } : {}),
    ...(metadata.currency && /^[A-Z]{3}$/.test(String(metadata.currency)) ? { currency: String(metadata.currency) } : {})
  };
}

function isEventType(type) {
  return publicEventTypes.has(type) || [
    "search_completed",
    "search_failed",
    "quote_reviewed",
    "quote_review_failed"
  ].includes(type);
}

function trimStore(store) {
  if (store.events.length > maxEvents) store.events.splice(0, store.events.length - maxEvents);
  if (store.audit.length > maxAuditEntries) store.audit.splice(0, store.audit.length - maxAuditEntries);
}

function createAuditEntry(action, clientId, targetId = "") {
  return {
    id: randomUUID(),
    action,
    targetId,
    clientId: createHashLabel(clientId),
    timestamp: new Date().toISOString()
  };
}

function createHashLabel(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `client-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function readCookie(header, name) {
  const cookies = String(header || "").split(";");
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

function pruneSessions(sessions, now) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
