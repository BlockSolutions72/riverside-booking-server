// app.js — builds and returns a configured Express app.
// Kept separate from server startup (see index.js) so it can be imported and
// tested with an in-memory/mock database, without binding a real network port.
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

import {
  getAvailableFromOptions,
  getAvailableToOptions,
  validateBookingRequest,
  computeLoadFraction,
  generateBookingReference,
} from "./bookingLogic.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function isValidDate(d) {
  return typeof d === "string" && DATE_RE.test(d);
}

// createApp(pool, options) — pool must be a `pg`-compatible Pool (real or pg-mem).
// options.jwtSecret lets tests pin a known secret instead of a random one.
export function createApp(pool, options = {}) {
  const JWT_SECRET = options.jwtSecret || process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
  if (!options.jwtSecret && !process.env.JWT_SECRET) {
    console.warn("JWT_SECRET not set — using a random secret generated at startup. Admin sessions won't survive a server restart. Set JWT_SECRET in your environment to avoid this.");
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" })); // generous limit to allow base64 logo uploads

// ---- auth middleware ----
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing admin token." });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}

// ---- helpers ----
async function getOrCreateWindow(client, date) {
  const result = await client.query(`SELECT * FROM day_windows WHERE date = $1`, [date]);
  if (result.rows.length > 0) return result.rows[0];
  // Default window — matches the original app's behavior of "every day defaults to 8-5, 60min interval"
  return {
    date,
    window_start: "08:00",
    window_end: "17:00",
    interval_minutes: 60,
    service_id: "detailing",
  };
}

async function getBookingsForDate(client, date) {
  const result = await client.query(
    `SELECT * FROM bookings WHERE date = $1 ORDER BY start_time ASC`,
    [date]
  );
  return result.rows;
}

async function isDateBlocked(client, date) {
  const result = await client.query(`SELECT 1 FROM blocked_dates WHERE date = $1`, [date]);
  return result.rows.length > 0;
}

// =================== PUBLIC ENDPOINTS ===================

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Get a single day's window + bookings + computed from/to options
app.get("/api/day/:date", async (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });

  const client = await pool.connect();
  try {
    const blocked = await isDateBlocked(client, date);
    const windowRow = await getOrCreateWindow(client, date);
    const bookings = await getBookingsForDate(client, date);
    const fromOptions = blocked ? [] : getAvailableFromOptions(windowRow, bookings);

    res.json({
      window: windowRow,
      blocked,
      bookings: bookings.map((b) => ({
        id: b.id,
        start: b.start_time,
        end: b.end_time,
        name: b.name,
        phone: b.phone,
        email: b.email,
        address: b.address,
        notes: b.notes,
        reference: b.reference || generateBookingReference(b.date.toISOString().slice(0, 10), b.start_time, b.end_time),
      })),
      fromOptions,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error loading day data." });
  } finally {
    client.release();
  }
});

// Get "to" options for a given date + chosen from-minute
app.get("/api/day/:date/to-options", async (req, res) => {
  const { date } = req.params;
  const fromMinute = Number(req.query.from);
  if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date format." });
  if (!Number.isFinite(fromMinute)) return res.status(400).json({ error: "Missing or invalid 'from' query param." });

  const client = await pool.connect();
  try {
    const windowRow = await getOrCreateWindow(client, date);
    const bookings = await getBookingsForDate(client, date);
    const toOptions = getAvailableToOptions(windowRow, bookings, fromMinute);
    res.json({ toOptions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  } finally {
    client.release();
  }
});

// Calendar month view — load fraction + blocked status per day, for the color-coded calendar
app.get("/api/calendar/:year/:month", async (req, res) => {
  const year = Number(req.params.year);
  const month = Number(req.params.month); // 1-12
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "Invalid year/month." });
  }

  const client = await pool.connect();
  try {
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const daysInMonth = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

    const windowsResult = await client.query(
      `SELECT * FROM day_windows WHERE date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    const bookingsResult = await client.query(
      `SELECT * FROM bookings WHERE date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    const blockedResult = await client.query(
      `SELECT date, reason FROM blocked_dates WHERE date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );

    const windowsByDate = {};
    for (const w of windowsResult.rows) {
      windowsByDate[w.date.toISOString().slice(0, 10)] = w;
    }
    const bookingsByDate = {};
    for (const b of bookingsResult.rows) {
      const key = b.date.toISOString().slice(0, 10);
      if (!bookingsByDate[key]) bookingsByDate[key] = [];
      bookingsByDate[key].push(b);
    }
    const blockedByDate = {};
    for (const row of blockedResult.rows) {
      blockedByDate[row.date.toISOString().slice(0, 10)] = row.reason || "";
    }

    const days = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isBlocked = Object.prototype.hasOwnProperty.call(blockedByDate, dateStr);
      if (isBlocked) {
        days[dateStr] = { blocked: true, fraction: null };
        continue;
      }
      // Only compute a fraction for days that have an explicit window saved OR fall back
      // to the same default the rest of the app uses, so the calendar matches day view.
      const windowRow = windowsByDate[dateStr] || {
        window_start: "08:00",
        window_end: "17:00",
        interval_minutes: 60,
      };
      const bookings = bookingsByDate[dateStr] || [];
      days[dateStr] = { blocked: false, fraction: computeLoadFraction(windowRow, bookings) };
    }

    res.json({ days });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error loading calendar data." });
  } finally {
    client.release();
  }
});

// Get branding (public — needed to render the header for anyone)
app.get("/api/branding", async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT value FROM settings WHERE key = 'branding'`);
    if (result.rows.length === 0) {
      return res.json({ name: "Riverside Detailing", logo: null });
    }
    res.json(JSON.parse(result.rows[0].value));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error loading branding." });
  } finally {
    client.release();
  }
});

// Create a booking — the critical endpoint. Re-validates everything server-side.
app.post("/api/bookings", async (req, res) => {
  const { date, start, end, name, phone, email, address, notes } = req.body || {};

  if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date." });
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return res.status(400).json({ error: "Invalid time format." });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required." });
  if (!String(phone || "").trim() && !String(email || "").trim()) {
    return res.status(400).json({ error: "Please provide a phone number or email." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const blocked = await isDateBlocked(client, date);
    if (blocked) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This day is out of service and isn't available for booking." });
    }

    const windowRow = await getOrCreateWindow(client, date);
    // Lock existing bookings for this date for the duration of this transaction so two
    // simultaneous booking requests for an overlapping slot can't both succeed (a real
    // race condition the original artifact had no way to prevent client-side).
    const existingResult = await client.query(
      `SELECT * FROM bookings WHERE date = $1 FOR UPDATE`,
      [date]
    );

    const validation = validateBookingRequest({
      window: windowRow,
      existingBookings: existingResult.rows,
      startHHMM: start,
      endHHMM: end,
    });

    if (!validation.ok) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: validation.message });
    }

    const reference = generateBookingReference(date, start, end);

    const insertResult = await client.query(
      `INSERT INTO bookings (date, start_time, end_time, service_id, name, phone, email, address, notes, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [date, start, end, windowRow.service_id || "detailing", name.trim(), (phone || "").trim(), (email || "").trim(), (address || "").trim(), (notes || "").trim(), reference]
    );

    await client.query("COMMIT");
    res.status(201).json({ booking: insertResult.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Server error creating booking." });
  } finally {
    client.release();
  }
});

// =================== ADMIN AUTH ===================

app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Password required." });

  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT value FROM settings WHERE key = 'admin_password_hash'`);
    if (result.rows.length === 0) return res.status(500).json({ error: "Admin password not configured." });

    const match = await bcrypt.compare(password, result.rows[0].value);
    if (!match) return res.status(401).json({ error: "Incorrect password." });

    const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error during login." });
  } finally {
    client.release();
  }
});

// =================== ADMIN-ONLY ENDPOINTS ===================

app.put("/api/admin/day/:date/window", requireAdmin, async (req, res) => {
  const { date } = req.params;
  const { window_start, window_end, interval_minutes, service_id } = req.body || {};

  if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date." });
  if (!TIME_RE.test(window_start) || !TIME_RE.test(window_end)) {
    return res.status(400).json({ error: "Invalid time format." });
  }
  const interval = Number(interval_minutes);
  if (!Number.isFinite(interval) || interval < 0) {
    return res.status(400).json({ error: "Invalid interval." });
  }

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO day_windows (date, window_start, window_end, interval_minutes, service_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (date) DO UPDATE SET
         window_start = EXCLUDED.window_start,
         window_end = EXCLUDED.window_end,
         interval_minutes = EXCLUDED.interval_minutes,
         service_id = EXCLUDED.service_id`,
      [date, window_start, window_end, interval, service_id || "detailing"]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error saving availability." });
  } finally {
    client.release();
  }
});

// Block a range of dates (inclusive). Refuses if ANY day in the range already
// has bookings — per product decision, blocking should only apply to future,
// unbooked days, not silently orphan existing customer bookings.
app.post("/api/admin/blocked-dates", requireAdmin, async (req, res) => {
  const { startDate, endDate, reason } = req.body || {};
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return res.status(400).json({ error: "Invalid date range." });
  }
  if (startDate > endDate) {
    return res.status(400).json({ error: "Start date must be on or before end date." });
  }

  // Build the list of individual dates in JS rather than relying on Postgres's
  // generate_series (some lightweight/managed Postgres-compatible engines don't
  // implement every native function, and a plain loop is just as clear here).
  const datesInRange = [];
  let cursor = new Date(startDate + "T00:00:00Z");
  const last = new Date(endDate + "T00:00:00Z");
  const MAX_RANGE_DAYS = 366; // sanity cap against accidental huge ranges (e.g. a typo'd year)
  while (cursor <= last) {
    datesInRange.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (datesInRange.length > MAX_RANGE_DAYS) {
      return res.status(400).json({ error: `Date range is too large (max ${MAX_RANGE_DAYS} days).` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const bookedCheck = await client.query(
      `SELECT DISTINCT date FROM bookings WHERE date BETWEEN $1 AND $2 ORDER BY date`,
      [startDate, endDate]
    );
    if (bookedCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      const datesList = bookedCheck.rows.map((r) => r.date.toISOString().slice(0, 10)).join(", ");
      return res.status(409).json({
        error: `Can't block this range — these days already have bookings: ${datesList}. Cancel those bookings first if you need to block these days.`,
      });
    }

    for (const d of datesInRange) {
      await client.query(
        `INSERT INTO blocked_dates (date, reason) VALUES ($1, $2)
         ON CONFLICT (date) DO UPDATE SET reason = EXCLUDED.reason`,
        [d, (reason || "").trim()]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Server error blocking dates." });
  } finally {
    client.release();
  }
});

app.delete("/api/admin/blocked-dates/:date", requireAdmin, async (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date." });

  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM blocked_dates WHERE date = $1`, [date]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error unblocking date." });
  } finally {
    client.release();
  }
});

app.get("/api/admin/blocked-dates", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT date, reason FROM blocked_dates ORDER BY date ASC`);
    res.json({
      blockedDates: result.rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        reason: r.reason || "",
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error loading blocked dates." });
  } finally {
    client.release();
  }
});

app.delete("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid booking id." });

  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM bookings WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error deleting booking." });
  } finally {
    client.release();
  }
});

app.put("/api/admin/password", requireAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || !String(newPassword).trim()) {
    return res.status(400).json({ error: "Password can't be empty." });
  }

  const client = await pool.connect();
  try {
    const hash = await bcrypt.hash(String(newPassword).trim(), 10);
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('admin_password_hash', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [hash]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error changing password." });
  } finally {
    client.release();
  }
});

app.put("/api/admin/branding", requireAdmin, async (req, res) => {
  const { name, logo } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Business name can't be empty." });

  const client = await pool.connect();
  try {
    const value = JSON.stringify({ name: String(name).trim(), logo: logo || null });
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('branding', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [value]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error saving branding." });
  } finally {
    client.release();
  }
});

// Admin view of a date range of bookings (for an admin dashboard / future export)
app.get("/api/admin/bookings", requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: "from and to query params must be YYYY-MM-DD dates." });
  }
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM bookings WHERE date BETWEEN $1 AND $2 ORDER BY date ASC, start_time ASC`,
      [from, to]
    );
    res.json({
      bookings: result.rows.map((b) => ({
        ...b,
        date: b.date.toISOString().slice(0, 10),
        reference: b.reference || generateBookingReference(b.date.toISOString().slice(0, 10), b.start_time, b.end_time),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error." });
  } finally {
    client.release();
  }
});

// Search bookings by reference number, phone, or name (case-insensitive partial match)
app.get("/api/admin/bookings/search", requireAdmin, async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: "Search query (q) is required." });
  }
  const term = q.trim();
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM bookings
       WHERE reference ILIKE $1
          OR phone ILIKE $1
          OR name ILIKE $1
       ORDER BY date DESC, start_time ASC
       LIMIT 50`,
      [`%${term}%`]
    );
    res.json({
      bookings: result.rows.map((b) => ({
        ...b,
        date: b.date.toISOString().slice(0, 10),
        reference: b.reference || generateBookingReference(b.date.toISOString().slice(0, 10), b.start_time, b.end_time),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error searching bookings." });
  } finally {
    client.release();
  }
});

// =================== SMS REMINDER ENDPOINTS ===================

// Helper: initialise a Twilio client from env vars (lazy — only called when
// actually sending, so the app starts fine without Twilio configured).
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in your environment.");
  }
  const twilio = require("twilio");          // CommonJS require works in ESM via createRequire
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Helper: load SMS settings from the database
async function getSmsSettings(client) {
  const result = await client.query(`SELECT value FROM settings WHERE key = 'sms_settings'`);
  if (result.rows.length === 0) {
    return { enabled: false, senderId: "", daysBeforeFirst: 2, daysBeforeSecond: 1, messageTemplate: "Hi {name}, this is a reminder that you have an appointment with {business} on {date} at {time}. Ref: {ref}" };
  }
  return JSON.parse(result.rows[0].value);
}

// Get/save SMS reminder settings (admin only)
app.get("/api/admin/sms-settings", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const settings = await getSmsSettings(client);
    res.json(settings);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error loading SMS settings." });
  } finally {
    client.release();
  }
});

app.put("/api/admin/sms-settings", requireAdmin, async (req, res) => {
  const { enabled, senderId, daysBeforeFirst, daysBeforeSecond, messageTemplate } = req.body || {};
  const settings = {
    enabled: !!enabled,
    senderId: (senderId || "").trim().slice(0, 11), // Alphanumeric sender IDs max 11 chars
    daysBeforeFirst: Math.max(1, Math.min(14, Number(daysBeforeFirst) || 2)),
    daysBeforeSecond: Math.max(0, Math.min(13, Number(daysBeforeSecond) || 1)),
    messageTemplate: (messageTemplate || "").trim() ||
      "Hi {name}, this is a reminder that you have an appointment with {business} on {date} at {time}. Ref: {ref}",
  };
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('sms_settings', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(settings)]
    );
    res.json({ ok: true, settings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error saving SMS settings." });
  } finally {
    client.release();
  }
});

// Send a manual SMS reminder for a specific booking (admin only)
app.post("/api/admin/bookings/:id/send-reminder", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid booking id." });

  const client = await pool.connect();
  try {
    const bookingResult = await client.query(`SELECT * FROM bookings WHERE id = $1`, [id]);
    if (bookingResult.rows.length === 0) return res.status(404).json({ error: "Booking not found." });
    const b = bookingResult.rows[0];

    if (!b.phone || !b.phone.trim()) {
      return res.status(400).json({ error: "This booking has no phone number — can't send SMS." });
    }

    const settings = await getSmsSettings(client);
    const brandingResult = await client.query(`SELECT value FROM settings WHERE key = 'branding'`);
    const branding = brandingResult.rows.length > 0 ? JSON.parse(brandingResult.rows[0].value) : { name: "Riverside Detailing" };

    const dateStr = b.date.toISOString().slice(0, 10);
    const ref = b.reference || generateBookingReference(dateStr, b.start_time, b.end_time);
    const timeStr = b.start_time.slice(0, 5);
    const message = settings.messageTemplate
      .replace("{name}", b.name)
      .replace("{business}", branding.name)
      .replace("{date}", dateStr)
      .replace("{time}", timeStr)
      .replace("{ref}", ref);

    let client2;
    try {
      client2 = getTwilioClient();
    } catch (e) {
      return res.status(503).json({ error: e.message });
    }

    await client2.messages.create({
      body: message,
      from: settings.senderId || process.env.TWILIO_SENDER_ID,
      to: b.phone.trim(),
    });

    await client.query(`UPDATE bookings SET reminder_sent = TRUE WHERE id = $1`, [id]);
    res.json({ ok: true, sentTo: b.phone.trim() });
  } catch (e) {
    console.error("SMS send error:", e);
    res.status(500).json({ error: e.message || "Failed to send SMS reminder." });
  } finally {
    client.release();
  }
});

// Automated daily reminder endpoint — called by cron-job.org each morning.
// Protected by a CRON_SECRET header so only your cron job can trigger it.
// Sends reminders for bookings happening in daysBeforeFirst and daysBeforeSecond
// days from today, skipping any booking that already has reminder_sent = TRUE.
app.post("/api/cron/send-reminders", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (!cronSecret || provided !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const client = await pool.connect();
  try {
    const settings = await getSmsSettings(client);
    if (!settings.enabled) {
      return res.json({ ok: true, sent: 0, skipped: 0, message: "SMS reminders are disabled." });
    }

    const brandingResult = await client.query(`SELECT value FROM settings WHERE key = 'branding'`);
    const branding = brandingResult.rows.length > 0 ? JSON.parse(brandingResult.rows[0].value) : { name: "Riverside Detailing" };

    // Get today's date in UTC — cron-job.org fires in UTC so this stays consistent
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const targetDays = [settings.daysBeforeFirst];
    if (settings.daysBeforeSecond > 0 && settings.daysBeforeSecond !== settings.daysBeforeFirst) {
      targetDays.push(settings.daysBeforeSecond);
    }

    const targetDates = targetDays.map((d) => {
      const t = new Date(today);
      t.setDate(t.getDate() + d);
      return t.toISOString().slice(0, 10);
    });

    const bookingsResult = await client.query(
      `SELECT * FROM bookings
       WHERE date = ANY($1::date[])
         AND reminder_sent = FALSE
         AND phone IS NOT NULL
         AND phone != ''
       ORDER BY date ASC, start_time ASC`,
      [targetDates]
    );

    let client2;
    try {
      client2 = getTwilioClient();
    } catch (e) {
      return res.status(503).json({ error: e.message });
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const b of bookingsResult.rows) {
      try {
        const dateStr = b.date.toISOString().slice(0, 10);
        const ref = b.reference || generateBookingReference(dateStr, b.start_time, b.end_time);
        const message = settings.messageTemplate
          .replace("{name}", b.name)
          .replace("{business}", branding.name)
          .replace("{date}", dateStr)
          .replace("{time}", b.start_time.slice(0, 5))
          .replace("{ref}", ref);

        await client2.messages.create({
          body: message,
          from: settings.senderId || process.env.TWILIO_SENDER_ID,
          to: b.phone.trim(),
        });

        await client.query(`UPDATE bookings SET reminder_sent = TRUE WHERE id = $1`, [b.id]);
        sent++;
      } catch (e) {
        console.error(`Failed to send reminder to booking ${b.id}:`, e.message);
        errors.push({ id: b.id, name: b.name, error: e.message });
        failed++;
      }
    }

    res.json({ ok: true, sent, failed, errors: errors.length > 0 ? errors : undefined });
  } catch (e) {
    console.error("Cron reminder error:", e);
    res.status(500).json({ error: "Server error running reminders." });
  } finally {
    client.release();
  }
});

  return app;
}
