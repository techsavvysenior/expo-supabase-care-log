import { ResendClient } from '../../../src/core/integrations/resend.ts';
import { env, optionalEnv } from '../_shared/http.ts';
import { unwrap, userClient } from '../_shared/supabase.ts';
import { createInviteHandler } from './handler.ts';

Deno.serve(
  createInviteHandler({
    email: new ResendClient({ apiKey: env('RESEND_API_KEY'), from: env('RESEND_FROM') }),
    linkBase: `${optionalEnv('APP_SCHEME') ?? 'carelog'}://invite?token=`,
    createInvitation: async (req, input) => {
      const { client } = await userClient(req);
      const rows = unwrap(
        await client.rpc('create_invitation', {
          p_org: input.orgId,
          p_email: input.email,
          p_role: input.role,
          p_site_ids: input.siteIds,
        }),
      ) as { invitation_id: string; token: string }[];
      const org = unwrap(await client.from('organizations').select('name').eq('id', input.orgId).single()) as { name: string };
      return { invitationId: rows[0].invitation_id, token: rows[0].token, organizationName: org.name };
    },
  }),
);
