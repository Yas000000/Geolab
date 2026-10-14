import { prisma } from "@/lib/prisma";
import { getTrackedPromptSet } from "@/lib/tracked-prompts";
import { dedupePrompts, parsePromptsText, promptKey } from "@/lib/parse-prompts";

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
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { text?: string };

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

  const unchanged =
    currentPrompts.length === prompts.length &&
    currentPrompts.every((p, i) => p.text === prompts[i].text && p.category === prompts[i].category);
  if (unchanged) {
    return Response.json({ count: prompts.length, added: 0, removed: 0, duplicates, unchanged: true });
  }

  const currentKeys = new Set(currentPrompts.map((p) => promptKey(p.text)));
  const newKeys = new Set(prompts.map((p) => promptKey(p.text)));
  const added = prompts.filter((p) => !currentKeys.has(promptKey(p.text))).length;
  const removed = currentPrompts.filter((p) => !newKeys.has(promptKey(p.text))).length;

  await prisma.promptSet.create({
    data: {
      clientId: id,
      label: `${client.name} — prompt list edited ${new Date().toISOString()}`,
      prompts: {
        create: prompts.map((p, i) => ({ category: p.category, text: p.text, position: i + 1 })),
      },
    },
  });

  return Response.json({ count: prompts.length, added, removed, duplicates, unchanged: false });
}
