import { prisma } from "@/lib/prisma";
import { RunStatus } from "@/generated/prisma/client";
import { STALE_RUN_MS } from "@/lib/scheduled-run";
import { STALE_MINUTES } from "@/lib/outreach";

/**
 * Archive, restore and delete for a client (Settings > Archive or Delete).
 *
 * Archived: hidden from the client list and skipped by every cron job (scheduled
 * runs, AI crawler checks, Google data pulls) and by the paid buttons (Run Now,
 * outreach builds, crawler checks, monthly reports). Every row is kept, so a
 * restore brings the full history back.
 *
 * Deleted: the client and everything under it, for good.
 */

/** Prisma filter for clients that aren't archived. */
export const ACTIVE = { archivedAt: null };

export async function setArchived(id: string, archived: boolean) {
  const client = await prisma.client.findUnique({ where: { id }, select: { archivedAt: true } });
  if (!client) return null;
  // Archiving twice keeps the first date.
  if (archived && client.archivedAt) return client;
  return prisma.client.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null },
    select: { archivedAt: true },
  });
}

/**
 * The reply a paid action sends for an archived client, or null when it may go ahead.
 * Used by the Run Now, outreach build, crawler check and monthly report routes.
 */
export async function archivedReply(id: string): Promise<Response | null> {
  const client = await prisma.client.findUnique({ where: { id }, select: { name: true, archivedAt: true } });
  if (!client?.archivedAt) return null;
  return Response.json(
    { error: `${client.name} is archived. Restore it in Settings before running anything new.` },
    { status: 409 },
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export type DeleteResult = { ok: true; name: string } | { ok: false; status: number; error: string };

export async function deleteClient(id: string, confirmName: string): Promise<DeleteResult> {
  const client = await prisma.client.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!client) return { ok: false, status: 404, error: "Client not found." };
  if (!sameName(confirmName, client.name)) {
    return { ok: false, status: 400, error: `Type ${client.name} exactly to confirm.` };
  }

  // A run or outreach build still writing rows would fail halfway, so wait for it.
  // Ones that stopped moving long ago (the same cutoffs their own code uses) don't count.
  const [run, build] = await Promise.all([
    prisma.run.findFirst({
      where: {
        clientId: id,
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
        startedAt: { gt: new Date(Date.now() - STALE_RUN_MS) },
      },
      select: { id: true },
    }),
    prisma.outreachPlan.findFirst({
      where: { clientId: id, status: "RUNNING", updatedAt: { gt: new Date(Date.now() - STALE_MINUTES * 60_000) } },
      select: { id: true },
    }),
  ]);
  if (run || build) {
    return {
      ok: false,
      status: 409,
      error: `${run ? "A run" : "An outreach build"} is in progress for ${client.name}. Delete it once that finishes.`,
    };
  }

  // Runs go first: Run -> PromptSet and RawResponse -> Prompt are RESTRICT, so deleting
  // the client alone could hit a prompt set that a run still points at. Deleting a run
  // cascades to its answers, citations, parsed results and mentions; deleting the client
  // then cascades to everything else (brands, prompt sets, snapshots, reports, outreach).
  await prisma.$transaction([
    prisma.run.deleteMany({ where: { clientId: id } }),
    prisma.client.delete({ where: { id } }),
  ]);
  return { ok: true, name: client.name };
}
