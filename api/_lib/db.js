import { neon } from "@neondatabase/serverless";
import { HttpError } from "./http.js";

let sql;

export async function getDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new HttpError(503, "O banco de dados ainda não está configurado.");
  }

  sql ??= neon(process.env.DATABASE_URL);
  return sql;
}
