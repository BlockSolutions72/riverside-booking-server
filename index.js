// index.js — thin production entry point.
// Creates a real pg Pool from DATABASE_URL and passes it to createApp().
// Kept separate from app.js so tests can inject an in-memory pool.
import pg from "pg";
import dotenv from "dotenv";
import { createRequire } from "module";
import { createApp } from "./app.js";
import { generateBookingReference } from "./bookingLogic.js";

dotenv.config();

const require = createRequire(import.meta.url);
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = createApp(pool);

// ---- SMS helper functions ----
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured.");
  }
  const twilio = require("twilio");
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function getSmsSettings(client) {
  const result = await client.query(`SELECT value FROM settings WHERE key = 'sms_settings'`);
  if (result.rows.length === 0) {
    return { enabled: false, senderId: "", daysBeforeFirst: 2, daysBeforeSecond: 1,
      messageTemplate: "Hi {name}, reminder: appointment with {business} on {date} at {time}. Ref: {ref}" };
  }
  return JSON.parse(result.rows[0].value);
}

function buildMessage(template, b, branding, dateStr, ref) {
  return template
    .replace("{name}", b.name)
    .replace("{business}", branding.name)
    .replace("{date}", dateStr)
    .replace("{time}", b.start_time.slice(0, 5))
    .replace("{ref}", ref);
}

// ---- SMS settings endpoints ----
app.get("/api/admin/sms-settings", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized." });
  const client = await pool.connect();
  try { res.json(await getSmsSettings(client)); }
  catch (e) { res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.put("/api/admin/sms-settings", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized." });
  const { enabled, senderId, daysBeforeFirst, daysBeforeSecond, messageTemplate } = req.body || {};
  const settings = {
    enabled: !!enabled,
    senderId: (senderId || "").trim().slice(0, 11),
    daysBeforeFirst: Math.max(1, Math.min(14, Number(daysBeforeFirst) || 2)),
    daysBeforeSecond: Math.max(0, Math.min(13, Number(daysBeforeSecond) || 1)),
    messageTemplate: (messageTemplate || "").trim() ||
      "Hi {name}, reminder: appointment with {business} on {date} at {time}. Ref: {ref}",
  };
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('sms_settings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(settings)]
    );
    res.json({ ok: true, settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ---- Manual send reminder ----
app.post("/api/admin/bookings/:id/send-reminder", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized." });
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid booking id." });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM bookings WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Booking not found." });
    const b = rows[0];
    if (!b.phone?.trim()) return res.status(400).json({ error: "No phone number on this booking." });
    const settings = await getSmsSettings(client);
    const br = await client.query(`SELECT value FROM settings WHERE key = 'branding'`);
    const branding = br.rows.length ? JSON.parse(br.rows[0].value) : { name: "Riverside Detailing" };
    const dateStr = b.date.toISOString().slice(0, 10);
    const ref = b.reference || generateBookingReference(dateStr, b.start_time, b.end_time);
    const message = buildMessage(settings.messageTemplate, b, branding, dateStr, ref);
    let tw; try { tw = getTwilioClient(); } catch (e) { return res.status(503).json({ error: e.message }); }
    await tw.messages.create({ body: message, from: settings.senderId || process.env.TWILIO_SENDER_ID, to: b.phone.trim() });
    await client.query(`UPDATE bookings SET reminder_sent = TRUE WHERE id = $1`, [id]);
    res.json({ ok: true, sentTo: b.phone.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ---- Automated cron endpoint ----
app.post("/api/cron/send-reminders", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (!cronSecret || provided !== cronSecret) return res.status(401).json({ error: "Unauthorized." });
  const client = await pool.connect();
  try {
    const settings = await getSmsSettings(client);
    if (!settings.enabled) return res.json({ ok: true, sent: 0, message: "SMS reminders are disabled." });
    const br = await client.query(`SELECT value FROM settings WHERE key = 'branding'`);
    const branding = br.rows.length ? JSON.parse(br.rows[0].value) : { name: "Riverside Detailing" };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const targetDays = [settings.daysBeforeFirst];
    if (settings.daysBeforeSecond > 0 && settings.daysBeforeSecond !== settings.daysBeforeFirst) targetDays.push(settings.daysBeforeSecond);
    const targetDates = targetDays.map(d => { const t = new Date(today); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); });
    const { rows } = await client.query(
      `SELECT * FROM bookings WHERE date = ANY($1::date[]) AND reminder_sent = FALSE AND phone IS NOT NULL AND phone != '' ORDER BY date ASC, start_time ASC`,
      [targetDates]
    );
    let tw; try { tw = getTwilioClient(); } catch (e) { return res.status(503).json({ error: e.message }); }
    let sent = 0, failed = 0; const errors = [];
    for (const b of rows) {
      try {
        const dateStr = b.date.toISOString().slice(0, 10);
        const ref = b.reference || generateBookingReference(dateStr, b.start_time, b.end_time);
        await tw.messages.create({ body: buildMessage(settings.messageTemplate, b, branding, dateStr, ref), from: settings.senderId || process.env.TWILIO_SENDER_ID, to: b.phone.trim() });
        await client.query(`UPDATE bookings SET reminder_sent = TRUE WHERE id = $1`, [b.id]);
        sent++;
      } catch (e) { errors.push({ id: b.id, error: e.message }); failed++; }
    }
    res.json({ ok: true, sent, failed, errors: errors.length ? errors : undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Riverside booking server listening on port ${PORT}`);
});
