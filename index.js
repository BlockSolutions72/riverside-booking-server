// index.js — server entry point.
// Creates a real Postgres pool from DATABASE_URL, builds the app via createApp(),
// and starts listening. Kept deliberately thin — all route logic lives in app.js
// so it can be tested without binding a real network port (see test_http.mjs).
import pg from "pg";
import dotenv from "dotenv";
import { createApp } from "./app.js";

dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Create a .env file (see .env.example) or set it in your hosting provider's environment variables.");
  process.exit(1);
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = createApp(pool);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Riverside booking server listening on port ${PORT}`);
});
