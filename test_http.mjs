// test_http.mjs
// Boots the ACTUAL app (via createApp from app.js — the same code that runs in
// production) against an in-memory Postgres-compatible database, then exercises
// it with real HTTP requests via supertest. This is as close to a real end-to-end
// test as is possible without a network-accessible Postgres instance.
//
// Run with: node test_http.mjs

import { newDb } from "pg-mem";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "./app.js";

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`PASS - ${label}`);
  } else {
    failed++;
    console.log(`FAIL - ${label}`);
  }
}

async function main() {
  const db = newDb();
  db.public.registerFunction({ name: "now", returns: "timestamptz", implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  await pool.query(`
    CREATE TABLE day_windows (
      date DATE PRIMARY KEY,
      window_start TEXT NOT NULL DEFAULT '08:00',
      window_end TEXT NOT NULL DEFAULT '17:00',
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      service_id TEXT NOT NULL DEFAULT 'detailing'
    );
  `);
  await pool.query(`
    CREATE TABLE bookings (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      service_id TEXT NOT NULL DEFAULT 'detailing',
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

  const passwordHash = await bcrypt.hash("testpass123", 10);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('admin_password_hash', $1)`, [passwordHash]);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('branding', $1)`, [JSON.stringify({ name: "Test Co", logo: null })]);

  const app = createApp(pool, { jwtSecret: "test-secret-for-http-tests" });

  // ---- health check ----
  let res = await request(app).get("/api/health");
  check("GET /api/health returns 200", res.status === 200);

  // ---- branding (public) ----
  res = await request(app).get("/api/branding");
  check("GET /api/branding returns seeded name", res.status === 200 && res.body.name === "Test Co");

  // ---- day with no window set yet falls back to defaults ----
  res = await request(app).get("/api/day/2026-08-01");
  check("GET /api/day returns 200 for a day with no saved window", res.status === 200);
  check("Fallback window is 08:00-17:00", res.body.window.window_start === "08:00" && res.body.window.window_end === "17:00");
  check("fromOptions populated for an empty day", Array.isArray(res.body.fromOptions) && res.body.fromOptions.length > 0);

  // ---- admin login fails with wrong password ----
  res = await request(app).post("/api/admin/login").send({ password: "wrongpassword" });
  check("Admin login rejects wrong password (401)", res.status === 401);

  // ---- admin login succeeds with correct password ----
  res = await request(app).post("/api/admin/login").send({ password: "testpass123" });
  check("Admin login succeeds with correct password", res.status === 200 && !!res.body.token);
  const token = res.body.token;

  // ---- unauthenticated request to admin route is rejected ----
  res = await request(app).put("/api/admin/day/2026-08-01/window").send({
    window_start: "09:00", window_end: "18:00", interval_minutes: 30,
  });
  check("Admin route rejects request with no token (401)", res.status === 401);

  // ---- authenticated admin can set a day's window ----
  res = await request(app)
    .put("/api/admin/day/2026-08-01/window")
    .set("Authorization", `Bearer ${token}`)
    .send({ window_start: "09:00", window_end: "18:00", interval_minutes: 30, service_id: "detailing" });
  check("Admin can set day window with valid token", res.status === 200 && res.body.ok === true);

  // ---- the day endpoint now reflects the saved window ----
  res = await request(app).get("/api/day/2026-08-01");
  check("Day window reflects the just-saved values", res.body.window.window_start === "09:00" && res.body.window.window_end === "18:00");

  // ---- public booking creation succeeds for a valid request ----
  res = await request(app).post("/api/bookings").send({
    date: "2026-08-01", start: "10:00", end: "11:00",
    name: "Jane Customer", phone: "555-0100", email: "", address: "", notes: "",
  });
  check("Booking creation succeeds for a valid, non-overlapping request", res.status === 201);

  // ---- booking creation fails without name ----
  res = await request(app).post("/api/bookings").send({
    date: "2026-08-01", start: "13:00", end: "14:00", name: "", phone: "555-0200",
  });
  check("Booking creation rejects missing name (400)", res.status === 400);

  // ---- booking creation fails without phone or email ----
  res = await request(app).post("/api/bookings").send({
    date: "2026-08-01", start: "13:00", end: "14:00", name: "No Contact",
  });
  check("Booking creation rejects missing phone AND email (400)", res.status === 400);

  // ---- booking creation fails when it overlaps an existing booking + buffer ----
  res = await request(app).post("/api/bookings").send({
    date: "2026-08-01", start: "10:30", end: "11:30", name: "Overlap Attempt", phone: "555-0300",
  });
  check("Booking creation rejects overlapping request (409)", res.status === 409);

  // ---- a genuinely free slot later in the day succeeds ----
  res = await request(app).post("/api/bookings").send({
    date: "2026-08-01", start: "14:00", end: "15:00", name: "Second Customer", phone: "555-0400",
  });
  check("Second non-overlapping booking succeeds", res.status === 201);

  // ---- the day now shows 2 bookings ----
  res = await request(app).get("/api/day/2026-08-01");
  check("Day now shows exactly 2 bookings", res.body.bookings.length === 2);

  // ---- admin can delete a booking ----
  const bookingIdToDelete = res.body.bookings[0].id;
  res = await request(app)
    .delete(`/api/admin/bookings/${bookingIdToDelete}`)
    .set("Authorization", `Bearer ${token}`);
  check("Admin can delete a booking", res.status === 200 && res.body.ok === true);

  res = await request(app).get("/api/day/2026-08-01");
  check("Day now shows exactly 1 booking after deletion", res.body.bookings.length === 1);

  // ---- admin can change the password, and old password stops working ----
  res = await request(app)
    .put("/api/admin/password")
    .set("Authorization", `Bearer ${token}`)
    .send({ newPassword: "newpassword456" });
  check("Admin password change succeeds", res.status === 200 && res.body.ok === true);

  res = await request(app).post("/api/admin/login").send({ password: "testpass123" });
  check("Old password no longer works after change", res.status === 401);

  res = await request(app).post("/api/admin/login").send({ password: "newpassword456" });
  check("New password works after change", res.status === 200 && !!res.body.token);

  // ---- admin can update branding ----
  res = await request(app)
    .put("/api/admin/branding")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "New Business Name", logo: null });
  check("Admin can update branding", res.status === 200 && res.body.ok === true);

  res = await request(app).get("/api/branding");
  check("Public branding endpoint reflects the update", res.body.name === "New Business Name");

  // ---- calendar endpoint returns load fractions ----
  res = await request(app).get("/api/calendar/2026/8");
  check("Calendar endpoint returns 200", res.status === 200);
  check("Calendar includes the booked day with a non-zero load", res.body.days["2026-08-01"] > 0);
  check("Calendar includes an empty day with zero load", res.body.days["2026-08-02"] === 0);

  // ---- invalid date format is rejected ----
  res = await request(app).get("/api/day/not-a-date");
  check("Invalid date format rejected (400)", res.status === 400);

  console.log(`\n${passed} passed, ${failed} failed.`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test run crashed:", e);
  process.exit(1);
});
