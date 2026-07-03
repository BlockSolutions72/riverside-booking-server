// migrate.js
// Run with: npm run migrate
// Creates the tables this app needs and seeds sensible defaults.
// Safe to run multiple times — uses CREATE TABLE IF NOT EXISTS and ON CONFLICT DO NOTHING.

import pg from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Create a .env file (see .env.example) or set it in your hosting provider's environment variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Creating tables...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS day_windows (
        date DATE PRIMARY KEY,
        window_start TEXT NOT NULL DEFAULT '08:00',
        window_end TEXT NOT NULL DEFAULT '17:00',
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        service_id TEXT NOT NULL DEFAULT 'detailing'
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
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
        reference TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_dates (
        date DATE PRIMARY KEY,
        reason TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    console.log("Seeding default settings (only if not already present)...");

    // Default admin password: "riverside1" — CHANGE THIS after first login.
    const defaultPasswordHash = await bcrypt.hash("riverside1", 10);
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('admin_password_hash', $1) ON CONFLICT (key) DO NOTHING;`,
      [defaultPasswordHash]
    );

    const defaultBranding = JSON.stringify({ name: "Riverside Detailing", logo: null });
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('branding', $1) ON CONFLICT (key) DO NOTHING;`,
      [defaultBranding]
    );

    const defaultJwtSecret = JSON.stringify({
      note: "If JWT_SECRET is not set in environment variables, a random one is generated at server startup instead. This row is unused but kept for visibility.",
    });
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('_info', $1) ON CONFLICT (key) DO NOTHING;`,
      [defaultJwtSecret]
    );

    console.log("Migration complete.");
    console.log("Default admin password is: riverside1 — change it immediately after first login.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
