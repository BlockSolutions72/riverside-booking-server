// smsRoutes.js — SMS reminder endpoints, split out from app.js to keep
// that file within GitHub's web editor paste limit.
import { createRequire } from "module";
const require = createRequire(import.meta.url);

function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in your environment.");
  }
  const twilio = require("twilio");
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function getSmsSettings(client) {
  const result = await client.query(`SELECT value FROM settings WHERE key = 'sms_settings'`);
  if (result.rows.length === 0) {
    return {
      enabled: false, senderId: "",
      daysBeforeFirst: 2, daysBeforeSecond: 1,
      messageTemplate: "Hi {name}, this is a reminder that you have an appointment with {business} on {date} at {time}. Ref: {ref}",
    };
  }
  return JSON.parse(result.rows[0].value);
}

export function registerSmsRoutes(app, pool, requireAdmin, generateBookingReference) {

  app.get("/api/admin/sms-settings", requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
      res.json(await getSmsSettings(client));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Server error loading SMS settings." });
    } finally { client.release(); }
  });

  app.put("/api/admin/sms-settings", requireAdmin, async (req, res) => {
    const { enabled, senderId, daysBeforeFirst, daysBeforeSecond, messageTemplate } = req.body || {};
    const settings = {
      enabled: !!enabled,
      senderId: (senderId || "").trim().slice(0, 11),
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
    } finally { client.release(); }
  });

  app.post("/api/admin/bookings/:id/send-reminder", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid booking id." });
    const client = await pool.connect();
    try {
      const bookingResult = await client.query(`SELECT * FROM bookings WHERE id = $1`, [id]);
      if (bookingResult.rows.length === 0) return res.status(404).json({ error: "Booking not found." });
      const b = bookingResult.rows[0];
      if (!b.phone || !b.phone.trim()) return res.status(400).json({ error: "This booking has no phone number." });

      const settings = await getSmsSettings(client);
      const brandingResult = await client.query(`SELECT value FROM settings WHERE key = 'branding'`);
      const branding = brandingResult.rows.length > 0 ? JSON.parse(brandingResult.rows[0].value) : { name: "Riverside Detailing" };

      const dateStr = b.date.toISOString().slice(0, 10);
      const ref = b.reference || generateBookingReference(dateStr, b.start_time, b.end_time);
      const message = settings.messageTemplate
        .replace("{name}", b.name).replace("{business}", branding.name)
        .replace("{date}", dateStr).replace("{time}", b.start_time.slice(0, 5)).replace("{ref}", ref);

      let tw;
      try { tw = getTwilioClient(); } catch (e) { return res.status(503).json({ error: e.message }); }
      await tw.messages.create({ body: message, from: settings.senderId || process.env.TWILIO_SENDER_ID, to: b.phone.trim() });
      await client.query(`UPDATE bookings SET reminder_sent = TRUE WHERE id = $1`, [id]);
      res.json({ ok: true, sentTo: b.phone.trim() });
    } catch (e) {
      console.error("SMS send error:", e);
      res.status(500).json({ error: e.message || "Failed to send SMS reminder." });
    } finally { client.release(); }
  });

  app.post("/api/cron/send-reminders", async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    const provided = req.headers["x-cron-secret"] || req.query.secret;
    if (!cronSecret || provided !== cronSecret) return res.status(401).json({ error: "Unauthorized." });

    const client = await pool.connect();
    try {
      const settings = await getSmsSettings(client);
      if (!settings.enabled) return res.json({ ok: true, sent: 0, message: "SMS reminders are disabled." });

      const brandingResult = await client.query(`SELECT value FROM settings WHERE key = 'branding'`);
      const branding = brandingResult.rows.length > 0 ? JSON.parse(brandingResult.rows[0].value) : { name: "Riverside Detailing" };

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const targetDays = [settings.daysBeforeFirst];
      if (settings.daysBeforeSecond > 0 && settings.daysBeforeSecond !== settings.daysBeforeFirst) targetDays.push(settings.daysBeforeSecond);
      const targetDates = targetDays.map((d) => { const t = new Date(today); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); });

      const bookingsResult = await client.query(
        `SELECT * FROM bookings WHERE date = ANY($1::date[]) AND reminder_sent = FALSE AND phone IS NOT NULL AND phone != '' ORDER BY date ASC, start_time ASC`,
        [targetDates]
      );

      let tw;
      try { tw = getTwilioClient(); } catch (e) { return res.status(503).json({ error: e.message }); }

      let sent = 0, failed = 0;
      const errors = [];
      for (const b of bookingsResult.rows) {
        try {
          const dateStr = b.date.toISOString().slice(0, 10);
          const ref = b.reference || generateBookingReference(dateStr, b.start_time, b.end_time);
          const message = settings.messageTemplate
            .replace("{name}", b.name).replace("{business}", branding.name)
            .replace("{date}", dateStr).replace("{time}", b.start_time.slice(0, 5)).replace("{ref}", ref);
          await tw.messages.create({ body: message, from: settings.senderId || process.env.TWILIO_SENDER_ID, to: b.phone.trim() });
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
    } finally { client.release(); }
  });
}
