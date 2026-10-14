import assert from "node:assert/strict";
import test from "node:test";
import { getDatabase } from "./db.js";

test("uses the Vercel Neon POSTGRES_URL when DATABASE_URL is not configured", async (context) => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = "postgresql://user:password@example.com/database";
  context.after(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
  });

  const database = await getDatabase();
  assert.equal(typeof database.query, "function");
});
