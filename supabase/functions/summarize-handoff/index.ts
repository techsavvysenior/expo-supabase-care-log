import { OpenAIClient } from '../../../src/core/integrations/openai.ts';
import { env } from '../_shared/http.ts';
import { unwrap, userClient } from '../_shared/supabase.ts';
import { createHandoffHandler } from './handler.ts';

type NoteRow = {
  note_id: string;
  resident_id: string;
  first_name: string;
  last_name: string;
  kind: string;
  body: string;
  occurred_at: string;
};

const ai = new OpenAIClient({ apiKey: env('OPENAI_API_KEY'), model: env('OPENAI_MODEL') });

Deno.serve(
  createHandoffHandler({
    ai,
    repoFor: async (req) => {
      const { client } = await userClient(req);
      return {
        aiEnabledForSite: async (siteId) => {
          const site = unwrap(
            await client.from('sites').select('organizations(ai_summaries_enabled)').eq('id', siteId).maybeSingle(),
          ) as { organizations: { ai_summaries_enabled: boolean } | null } | null;
          return site ? site.organizations?.ai_summaries_enabled === true : undefined;
        },
        notes: async (siteId, from, to) => {
          const rows = unwrap(await client.rpc('handoff_notes', { p_site: siteId, p_from: from, p_to: to })) as NoteRow[];
          return rows.map((r) => ({
            residentId: r.resident_id,
            firstName: r.first_name,
            lastName: r.last_name,
            kind: r.kind,
            body: r.body,
            occurredAt: r.occurred_at,
          }));
        },
        recordRequest: async (siteId, noteCount) => {
          unwrap(await client.rpc('record_ai_handoff_request', { p_site: siteId, p_note_count: noteCount }));
        },
      };
    },
  }),
);
