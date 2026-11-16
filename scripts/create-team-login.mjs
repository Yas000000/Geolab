// Creates a TEAM login (or resets one's password) straight in the database, with a generated
// password that must be changed at first sign-in. For the very first login, when nobody can
// sign in to the Access page yet, and for getting back in if every team login is locked out.
//
//   node scripts/create-team-login.mjs you@example.com "Your Name"
//   node scripts/create-team-login.mjs you@example.com --reset
//
// Uses DATABASE_URL_UNPOOLED from the environment, else from .env.local (production!).
// The password format matches src/lib/password.ts.
import { randomBytes, randomInt, scrypt as scryptCb } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

function envUrl() {
  if (process.env.DATABASE_URL_UNPOOLED) return process.env.DATABASE_URL_UNPOOLED;
  const line = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DATABASE_URL_UNPOOLED="));
  if (!line) throw new Error("DATABASE_URL_UNPOOLED not set and not in .env.local");
  return line.slice("DATABASE_URL_UNPOOLED=".length).replace(/^"|"$/g, "");
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generatePassword = () =>
  Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")).join("-");

const hashPassword = (password) =>
  new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scryptCb(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(["scrypt", 16384, 8, 1, salt.toString("base64"), key.toString("base64")].join("$")),
    );
  });

const [email0, arg2] = process.argv.slice(2);
if (!email0) {
  console.error('usage: node scripts/create-team-login.mjs <email> ["Name" | --reset]');
  process.exit(1);
}
const email = email0.trim().toLowerCase();
const reset = arg2 === "--reset";
const name = !reset && arg2 ? arg2 : null;

const url = envUrl();
const db = new Client({ connectionString: url });
await db.connect();
console.log(`database host: ${new URL(url).host}`);
try {
  const password = generatePassword();
  const hash = await hashPassword(password);
  const existing = await db.query(`SELECT id, role FROM "User" WHERE email = $1`, [email]);
  if (reset) {
    if (!existing.rows[0]) throw new Error(`No login for ${email}.`);
    if (existing.rows[0].role !== "TEAM") throw new Error(`${email} is not a team login.`);
    await db.query(
      `UPDATE "User" SET "passwordHash" = $1, "mustChangePassword" = true, "failedLogins" = 0, "lockedUntil" = NULL, "disabledAt" = NULL, "updatedAt" = now() WHERE id = $2`,
      [hash, existing.rows[0].id],
    );
    await db.query(`DELETE FROM "Session" WHERE "userId" = $1`, [existing.rows[0].id]);
    console.log(`Password reset for ${email}.`);
  } else {
    if (existing.rows[0]) throw new Error(`${email} already has a login (use --reset).`);
    const id = `usr_${randomBytes(12).toString("hex")}`;
    await db.query(
      `INSERT INTO "User" (id, email, name, role, "passwordHash", "mustChangePassword", "updatedAt") VALUES ($1, $2, $3, 'TEAM', $4, true, now())`,
      [id, email, name, hash],
    );
    console.log(`Team login created for ${email}.`);
  }
  console.log(`Temporary password: ${password}`);
  console.log("It must be changed at first sign-in.");
} finally {
  await db.end();
}
