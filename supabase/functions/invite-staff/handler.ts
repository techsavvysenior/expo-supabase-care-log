import { HttpError, json, readBody, requireUuid, route } from '../_shared/http.ts';

const ROLES = ['admin', 'nurse', 'caregiver', 'auditor'] as const;
type Role = (typeof ROLES)[number];

export type InviteDeps = {
  /** Runs create_invitation() as the caller; the database checks they are an admin. */
  createInvitation(
    req: Request,
    input: { orgId: string; email: string; role: Role; siteIds: string[] },
  ): Promise<{ invitationId: string; token: string; organizationName: string }>;
  email: { send(email: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id: string }> };
  /** e.g. carelog://invite?token= */
  linkBase: string;
};

/**
 * Creates an invitation and emails the link. The token is in the email and
 * nowhere else: the database stores only its hash, and this function does
 * not return it, so an admin can't copy someone else's invite link.
 */
export function createInviteHandler(deps: InviteDeps): (req: Request) => Promise<Response> {
  return route(async (req) => {
    const body = await readBody<{ org_id?: unknown; email?: unknown; role?: unknown; site_ids?: unknown }>(req);
    const orgId = requireUuid(body.org_id, 'org_id');
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_email');
    if (!ROLES.includes(body.role as Role)) throw new HttpError(400, 'invalid_role');
    const siteIds = Array.isArray(body.site_ids) ? body.site_ids.map((id, i) => requireUuid(id, `site_ids_${i}`)) : [];
    if (body.role === 'caregiver' && siteIds.length === 0) throw new HttpError(400, 'caregiver_needs_a_site');

    const invite = await deps.createInvitation(req, { orgId, email, role: body.role as Role, siteIds });
    const link = `${deps.linkBase}${encodeURIComponent(invite.token)}`;
    await deps.email.send({
      to: email,
      subject: `You've been invited to ${invite.organizationName} on Care Log`,
      text: [
        `You've been invited to join ${invite.organizationName} on Care Log.`,
        '',
        `Open this link on your phone after installing the app: ${link}`,
        '',
        'The link works once and expires in 7 days. Sign in with this email address to accept it.',
      ].join('\n'),
      idempotencyKey: `invitation-${invite.invitationId}`,
    });
    return json({ invitation_id: invite.invitationId, emailed: true }, 201);
  });
}
