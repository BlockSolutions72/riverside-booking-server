// index.js — thin production entry point.
// Creates a real pg Pool from DATABASE_URL and passes it to createApp().
// Kept separate from app.js so tests can inject an in-memory pool.
import pg from "pg";
import dotenv from "dotenv";
import { createApp } from "./app.js";

dotenv.config();

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
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Riverside booking server listening on port ${PORT}`);
});
