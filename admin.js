const elements = {
  loginPanel: document.querySelector("#loginPanel"),
  loginForm: document.querySelector("#loginForm"),
  password: document.querySelector("#passwordInput"),
  loginStatus: document.querySelector("#loginStatus"),
  dashboard: document.querySelector("#dashboard"),
  generatedAt: document.querySelector("#generatedAt"),
  cashflowCards: document.querySelector("#cashflowCards"),
  activityCards: document.querySelector("#activityCards"),
  activityChart: document.querySelector("#activityChart"),
  topLocations: document.querySelector("#topLocations"),
  transactionForm: document.querySelector("#transactionForm"),
  transactionDate: document.querySelector("#transactionDate"),
  transactionStatus: document.querySelector("#transactionStatus"),
  transactionRows: document.querySelector("#transactionRows"),
  transactionEmpty: document.querySelector("#transactionEmpty"),
  refresh: document.querySelector("#refreshButton"),
  logout: document.querySelector("#logoutButton")
};

const state = {
  csrfToken: "",
  dashboard: null
};

elements.transactionDate.value = new Date().toISOString().slice(0, 10);
restoreSession();

async function restoreSession() {
  try {
    const response = await fetch("/api/admin/session");
    if (!response.ok) {
      showLogin();
      return;
    }
    const session = await response.json();
    state.csrfToken = session.csrfToken;
    showDashboard();
    await loadDashboard();
  } catch {
    showLogin("The admin service is unavailable.");
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormStatus(elements.loginStatus, "Signing in...");

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: elements.password.value })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to sign in.");

    state.csrfToken = payload.csrfToken;
    elements.password.value = "";
    showDashboard();
    await loadDashboard();
  } catch (error) {
    setFormStatus(elements.loginStatus, error.message, "error");
  }
});

elements.transactionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(elements.transactionForm);
  const transaction = Object.fromEntries(form.entries());
  setFormStatus(elements.transactionStatus, "Saving transaction...");

  try {
    await adminRequest("/api/admin/transactions", {
      method: "POST",
      body: JSON.stringify(transaction)
    });
    elements.transactionForm.reset();
    elements.transactionDate.value = new Date().toISOString().slice(0, 10);
    setFormStatus(elements.transactionStatus, "Transaction added.", "success");
    await loadDashboard();
  } catch (error) {
    setFormStatus(elements.transactionStatus, error.message, "error");
  }
});

elements.transactionRows.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-transaction]");
  if (!button) return;
  if (!window.confirm("Delete this transaction? This cannot be undone.")) return;

  try {
    await adminRequest(`/api/admin/transactions/${encodeURIComponent(button.dataset.deleteTransaction)}`, {
      method: "DELETE"
    });
    await loadDashboard();
  } catch (error) {
    setFormStatus(elements.transactionStatus, error.message, "error");
  }
});

elements.refresh.addEventListener("click", loadDashboard);
elements.logout.addEventListener("click", async () => {
  try {
    await adminRequest("/api/admin/logout", { method: "POST" });
  } finally {
    state.csrfToken = "";
    state.dashboard = null;
    showLogin("Signed out.");
  }
});

async function loadDashboard() {
  elements.refresh.disabled = true;
  try {
    state.dashboard = await adminRequest("/api/admin/dashboard");
    renderDashboard(state.dashboard);
  } catch (error) {
    if (error.status !== 401) setFormStatus(elements.transactionStatus, error.message, "error");
  } finally {
    elements.refresh.disabled = false;
  }
}

async function adminRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(["POST", "PUT", "PATCH", "DELETE"].includes(options.method) && state.csrfToken
      ? { "x-csrf-token": state.csrfToken }
      : {})
  };
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) showLogin("Your admin session has expired.");
    const error = new Error(payload.error || "Admin request failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function renderDashboard(dashboard) {
  elements.generatedAt.textContent = `Updated ${formatDateTime(dashboard.generatedAt)}`;
  renderCashflow(dashboard.cashflow);
  renderActivity(dashboard.activity);
  renderChart(dashboard.activity.daily);
  renderLocations(dashboard.activity.topLocations);
  renderTransactions(dashboard.transactions);
}

function renderCashflow(cashflow) {
  if (!cashflow.length) {
    elements.cashflowCards.innerHTML = `
      <article class="metric-card">
        <small>No ledger data</small>
        <strong>—</strong>
        <span>Add a transaction below to begin cashflow reporting.</span>
      </article>
    `;
    return;
  }

  elements.cashflowCards.innerHTML = cashflow.map((summary) => `
    <div class="currency-group">
      <p class="currency-label">${escapeHtml(summary.currency)}</p>
      ${metricCard("Cash in", money(summary.cashIn, summary.currency), "Settled inflows")}
      ${metricCard("Cash out", money(summary.cashOut, summary.currency), "Settled outflows")}
      ${metricCard("Net cashflow", money(summary.net, summary.currency), `${summary.transactionCount} active entries`)}
      ${metricCard("Pending", money(summary.pending, summary.currency), `Gross booking value ${money(summary.grossBookingValue, summary.currency)}`)}
    </div>
  `).join("");
}

function renderActivity(activity) {
  const metrics = [
    ["Searches", activity.searches, `${activity.searchFailures} failed`],
    ["Offers returned", activity.offersReturned, "Across completed searches"],
    ["Quote reviews", activity.quoteReviews, `${activity.quoteFailures} failed`],
    ["Cars saved", activity.carsSaved, `${activity.savedQuoteChecks} saved-quote checks`],
    ["Unavailable saves", activity.unavailableSavedQuotes, "Found during live rechecks"]
  ];
  elements.activityCards.innerHTML = metrics
    .map(([label, value, note]) => metricCard(label, number(value), note))
    .join("");
}

function renderChart(days) {
  const maximum = Math.max(1, ...days.flatMap((day) => [day.searches, day.quoteReviews]));
  elements.activityChart.innerHTML = `
    ${days.map((day) => `
      <div class="chart-day" title="${escapeHtml(`${day.date}: ${day.searches} searches, ${day.quoteReviews} quote reviews`)}">
        <div class="chart-bars">
          <span class="chart-bar height-${heightStep(day.searches, maximum)}"></span>
          <span class="chart-bar quote height-${heightStep(day.quoteReviews, maximum)}"></span>
        </div>
        <small>${escapeHtml(day.date.slice(5))}</small>
      </div>
    `).join("")}
    <div class="chart-legend">
      <span>Searches</span>
      <span>Quote reviews</span>
    </div>
  `;
}

function renderLocations(locations) {
  elements.topLocations.innerHTML = locations.length
    ? locations.map((item, index) => `
        <div class="rank-row">
          <span>${index + 1}. ${escapeHtml(item.location)}</span>
          <strong>${number(item.searches)}</strong>
        </div>
      `).join("")
    : `<p class="empty-copy">No location searches recorded yet.</p>`;
}

function renderTransactions(transactions) {
  elements.transactionEmpty.hidden = transactions.length > 0;
  elements.transactionRows.innerHTML = transactions.map((transaction) => {
    const sign = transaction.direction === "inflow" ? "+" : "−";
    return `
      <tr>
        <td>${escapeHtml(transaction.date)}</td>
        <td>${escapeHtml(formatCategory(transaction.category))}</td>
        <td><span class="status-pill">${escapeHtml(transaction.status)}</span></td>
        <td>${escapeHtml(transaction.reference || "—")}</td>
        <td class="number-cell amount-${escapeHtml(transaction.direction)}">
          ${sign}${escapeHtml(money(transaction.amount, transaction.currency))}
        </td>
        <td>
          <button class="delete-button" type="button" data-delete-transaction="${escapeHtml(transaction.id)}">Delete</button>
        </td>
      </tr>
    `;
  }).join("");
}

function metricCard(label, value, note) {
  return `
    <article class="metric-card">
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(note)}</span>
    </article>
  `;
}

function showLogin(message = "") {
  elements.loginPanel.hidden = false;
  elements.dashboard.hidden = true;
  setFormStatus(elements.loginStatus, message, message ? "error" : "");
  elements.password.focus();
}

function showDashboard() {
  elements.loginPanel.hidden = true;
  elements.dashboard.hidden = false;
  setFormStatus(elements.loginStatus, "");
}

function setFormStatus(element, message, type = "") {
  element.textContent = message;
  element.dataset.type = type;
}

function money(value, currency) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

function number(value) {
  return new Intl.NumberFormat("en-GB").format(Number(value) || 0);
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "now"
    : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatCategory(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function heightStep(value, maximum) {
  return Math.max(0, Math.min(10, Math.ceil((Number(value) / maximum) * 10)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

