import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAdminDashboard,
  createAdminService,
  normalizeAdminTransaction
} from "./admin-server.js";
import { createAppServer } from "./server.js";

test("validates and normalizes manual cashflow entries", () => {
  const transaction = normalizeAdminTransaction({
    date: "2026-07-30",
    direction: "inflow",
    category: "booking_commission",
    status: "settled",
    amount: "42.129",
    currency: "gbp",
    grossBookingValue: "360",
    reference: "  BOOK-123  "
  }, new Date("2026-07-30T12:00:00Z"));

  assert.equal(transaction.amount, 42.13);
  assert.equal(transaction.currency, "GBP");
  assert.equal(transaction.reference, "BOOK-123");
  assert.equal(transaction.grossBookingValue, 360);
  assert.throws(() => normalizeAdminTransaction({
    ...transaction,
    amount: 0
  }), /greater than zero/);
});

test("keeps currencies separate when calculating cashflow", () => {
  const dashboard = buildAdminDashboard({
    transactions: [
      {
        id: "one",
        date: "2026-07-30",
        direction: "inflow",
        category: "booking_commission",
        status: "settled",
        amount: 50,
        currency: "GBP",
        grossBookingValue: 400,
        createdAt: "2026-07-30T10:00:00Z"
      },
      {
        id: "two",
        date: "2026-07-30",
        direction: "outflow",
        category: "api_cost",
        status: "settled",
        amount: 10,
        currency: "GBP",
        grossBookingValue: 0,
        createdAt: "2026-07-30T11:00:00Z"
      },
      {
        id: "three",
        date: "2026-07-30",
        direction: "inflow",
        category: "affiliate_payout",
        status: "pending",
        amount: 25,
        currency: "USD",
        grossBookingValue: 0,
        createdAt: "2026-07-30T12:00:00Z"
      }
    ],
    events: [],
    audit: []
  }, new Date("2026-07-30T13:00:00Z"));

  assert.deepEqual(dashboard.cashflow, [
    {
      currency: "GBP",
      cashIn: 50,
      cashOut: 10,
      net: 40,
      pending: 0,
      grossBookingValue: 400,
      transactionCount: 2
    },
    {
      currency: "USD",
      cashIn: 0,
      cashOut: 0,
      net: 0,
      pending: 25,
      grossBookingValue: 0,
      transactionCount: 1
    }
  ]);
});

test("protects admin data and persists ledger and analytics", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "smart-rental-admin-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const service = createAdminService({
    dataFile: join(directory, "admin.json"),
    passwordProvider: () => "a-long-test-password"
  });

  assert.equal(service.login("wrong", "local").status, 401);
  const login = service.login("a-long-test-password", "local");
  assert.equal(login.status, 200);

  const session = service.authenticate({
    headers: { cookie: `admin_session=${login.token}` }
  });
  assert.equal(session.csrfToken, login.csrfToken);

  const transaction = await service.addTransaction({
    date: "2026-07-30",
    direction: "inflow",
    category: "booking_commission",
    status: "settled",
    amount: 35,
    currency: "GBP"
  }, "local");
  await service.recordEvent("search_completed", {
    location: "Lincoln",
    markets: 1,
    offers: 182,
    currency: "GBP"
  });

  const dashboard = await service.getDashboard();
  assert.equal(dashboard.cashflow[0].net, 35);
  assert.equal(dashboard.activity.searches, 1);
  assert.equal(dashboard.activity.offersReturned, 182);
  assert.equal(dashboard.activity.topLocations[0].location, "Lincoln");

  assert.equal(await service.deleteTransaction(transaction.id, "local"), true);
  assert.equal((await service.getDashboard()).transactions.length, 0);

  service.logout(login.token, "local");
  assert.equal(service.authenticate({
    headers: { cookie: `admin_session=${login.token}` }
  }), null);
});

test("enforces login cookies and CSRF protection on admin routes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "smart-rental-admin-route-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const service = createAdminService({
    dataFile: join(directory, "admin.json"),
    passwordProvider: () => "another-long-test-password"
  });
  const server = createAppServer({ adminService: service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "another-long-test-password" })
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const rejected = await fetch(`${baseUrl}/api/admin/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: baseUrl
    },
    body: "{}"
  });
  assert.equal(rejected.status, 403);

  const created = await fetch(`${baseUrl}/api/admin/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: baseUrl,
      "x-csrf-token": login.csrfToken
    },
    body: JSON.stringify({
      date: "2026-07-30",
      direction: "inflow",
      category: "booking_commission",
      status: "settled",
      amount: 12.5,
      currency: "GBP"
    })
  });
  assert.equal(created.status, 201);

  const dashboardResponse = await fetch(`${baseUrl}/api/admin/dashboard`, {
    headers: { Cookie: cookie }
  });
  assert.equal(dashboardResponse.status, 200);
  assert.equal((await dashboardResponse.json()).cashflow[0].net, 12.5);
});
