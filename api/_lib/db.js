import { neon } from "@neondatabase/serverless";
import { HttpError } from "./http.js";

let sql;

export async function getDatabase() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    throw new HttpError(503, "O banco de dados ainda não está configurado.");
  }

  sql ??= neon(databaseUrl);
  return sql;
}
