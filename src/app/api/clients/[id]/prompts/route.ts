import { prisma } from "@/lib/prisma";
import { getTrackedPromptSet, samePromptList, saveTrackedPrompts } from "@/lib/tracked-prompts";
import { dedupePrompts, parsePromptsText, promptKey } from "@/lib/parse-prompts";
import { requireTeam } from "@/lib/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replaces a client's tracked prompt list with the pasted text. Saved as a
 * new run-less PromptSet rather than editing the current one in place --
 * the current set's Prompt rows are referenced by past runs' RawResponses,
 * so mutating them would rewrite history. The next Run Now / scheduled run
 * picks this set up via getTrackedPromptSet().
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/clients/[id]/prompts">): Promise<Response> {
  const viewer = await requireTeam();
  if (viewer instanceof Response) return viewer;
  const { id } = await ctx.params;
  // locations: each prompt's location ids, keyed by promptKey(text). A prompt left out keeps
  // the locations it already had, or (new prompt) gets newPromptLocationIds.
  const body = (await request.json().catch(() => ({}))) as {
    text?: string;
    locations?: Record<string, string[]>;
    newPromptLocationIds?: string[];
  };

  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const { prompts, duplicates } = dedupePrompts(parsePromptsText(body.text ?? ""));
  if (prompts.length === 0) {
    return Response.json({ error: "Paste at least one prompt." }, { status: 400 });
  }

  const current = await getTrackedPromptSet(id);
  const currentPrompts = current?.prompts ?? [];

  // Only this client's own location ids are kept.
  const own = new Set((await prisma.clientLocation.findMany({ where: { clientId: id }, select: { id: true } })).map((l) => l.id));
  const before = new Map(currentPrompts.map((p) => [promptKey(p.text), p.locationIds ?? []]));
  const withLocations = prompts.map((p) => {
    const key = promptKey(p.text);
    const ids = body.locations?.[key] ?? before.get(key) ?? body.newPromptLocationIds ?? [];
    return { ...p, locationIds: [...new Set(ids)].filter((x) => own.has(x)) };
  });

  const unchanged = samePromptList(currentPrompts, withLocations);
  if (unchanged) {
    return Response.json({ count: prompts.length, added: 0, removed: 0, duplicates, unchanged: true });
  }

  const currentKeys = new Set(currentPrompts.map((p) => promptKey(p.text)));
  const newKeys = new Set(prompts.map((p) => promptKey(p.text)));
  const added = prompts.filter((p) => !currentKeys.has(promptKey(p.text))).length;
  const removed = currentPrompts.filter((p) => !newKeys.has(promptKey(p.text))).length;

  await saveTrackedPrompts(id, `${client.name} — prompt list edited ${new Date().toISOString()}`, withLocations);

  return Response.json({ count: prompts.length, added, removed, duplicates, unchanged: false });
}
