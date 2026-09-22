import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Runtime queries use the pooled DATABASE_URL via a driver adapter (required
// in Prisma 7 -- a bare connection string is no longer accepted). Migrations
// use the unpooled DATABASE_URL_UNPOOLED instead (see prisma7.config.ts) --
// Neon's pooler is PgBouncer transaction-mode, which doesn't support the
// session-level features Prisma's migration engine needs, but is fine for
// normal queries.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

// Reuse the client across Next.js dev-mode hot reloads instead of opening a
// new connection pool on every file change.
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
