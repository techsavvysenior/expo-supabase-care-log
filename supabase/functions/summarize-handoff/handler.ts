import { pseudonymize, reidentify, type HandoffNote } from '../../../src/core/handoff/pseudonymize.ts';
import type { HandoffDraft } from '../../../src/core/integrations/openai.ts';
import { HttpError, json, readBody, requireIsoDate, requireUuid, route } from '../_shared/http.ts';

/** What the handler needs from the database, through the caller's own RLS. */
export type HandoffRepo = {
  aiEnabledForSite(siteId: string): Promise<boolean | undefined>;
  notes(siteId: string, from: string, to: string): Promise<HandoffNote[]>;
  recordRequest(siteId: string, noteCount: number): Promise<void>;
};

export type HandoffDeps = {
  /** Resolves the caller from their JWT; throws HttpError(401) if missing. */
  repoFor(req: Request): Promise<HandoffRepo>;
  ai: { draftHandoff(input: string): Promise<HandoffDraft> };
  maxWindowHours?: number;
};

/**
 * Drafts a shift handoff from one site's notes. The draft is returned to the
 * app, where a staff member edits it and posts it as their own handoff note.
 * Nothing the model writes is saved by this function.
 */
export function createHandoffHandler(deps: HandoffDeps): (req: Request) => Promise<Response> {
  return route(async (req) => {
    const repo = await deps.repoFor(req);
    const body = await readBody<{ site_id?: unknown; from?: unknown; to?: unknown }>(req);
    const siteId = requireUuid(body.site_id, 'site_id');
    const from = requireIsoDate(body.from, 'from');
    const to = requireIsoDate(body.to, 'to');

    const hours = (Date.parse(to) - Date.parse(from)) / 3_600_000;
    if (hours <= 0 || hours > (deps.maxWindowHours ?? 16)) throw new HttpError(400, 'invalid_window');

    const enabled = await repo.aiEnabledForSite(siteId);
    if (enabled === undefined) throw new HttpError(404, 'site_not_found');
    if (!enabled) throw new HttpError(403, 'AI_NOT_ENABLED');

    const notes = await repo.notes(siteId, from, to);
    if (notes.length === 0) return json({ summary: '', follow_ups: [], note_count: 0 });

    // Audit before the call, so an attempt is recorded even if OpenAI fails.
    await repo.recordRequest(siteId, notes.length);

    const { prompt, labels } = pseudonymize(notes);
    const draft = reidentify(await deps.ai.draftHandoff(prompt), labels);
    return json({
      summary: draft.summary,
      follow_ups: draft.followUps.map((f) => ({ resident: f.resident, resident_id: f.residentId ?? null, action: f.action })),
      note_count: notes.length,
    });
  });
}
