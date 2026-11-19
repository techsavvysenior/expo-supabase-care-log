import { useQuery } from '@tanstack/react-query';

import { toAppError } from '@/core/errors';
import type { DueDose } from '@/core/mar/dose-window';
import { rpc } from '@/lib/functions';
import { supabase } from '@/lib/supabase';

/**
 * Every read goes through the signed-in user's client, so row-level security
 * decides what comes back. Query keys start with the organization id so
 * switching providers never shows one provider's cache under another.
 */

export type Site = { id: string; name: string; timezone: string; latitude: number | null; longitude: number | null };
export type Resident = { id: string; site_id: string; first_name: string; last_name: string; room: string | null; date_of_birth: string };
export type CareNote = {
  id: string;
  kind: 'observation' | 'incident' | 'handoff' | 'correction';
  body: string;
  occurred_at: string;
  created_at: string;
  author_id: string;
  amends_note_id: string | null;
  resident_id: string;
};
export type AuditEvent = { id: number; action: string; actor_id: string | null; entity_id: string | null; at: string };

async function select<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw toAppError(error);
  return data as T;
}

export function useSites(orgId: string | undefined) {
  return useQuery({
    queryKey: [orgId, 'sites'],
    enabled: !!orgId,
    queryFn: () =>
      select<Site[]>(supabase.from('sites').select('id, name, timezone, latitude, longitude').eq('org_id', orgId as string).order('name')),
  });
}

export function useResidents(orgId: string | undefined, siteId: string | undefined) {
  return useQuery({
    queryKey: [orgId, 'residents', siteId],
    enabled: !!orgId && !!siteId,
    queryFn: () =>
      select<Resident[]>(
        supabase
          .from('residents')
          .select('id, site_id, first_name, last_name, room, date_of_birth')
          .eq('site_id', siteId as string)
          .is('discharged_on', null)
          .order('last_name'),
      ),
  });
}

/** Opens a chart through open_resident(), which writes the "viewed" audit entry. */
export function useResident(orgId: string | undefined, residentId: string) {
  return useQuery({
    queryKey: [orgId, 'resident', residentId],
    enabled: !!orgId,
    staleTime: Infinity,
    queryFn: () => rpc<Resident>('open_resident', { p_resident: residentId }),
  });
}

export function useNotes(orgId: string | undefined, residentId: string) {
  return useQuery({
    queryKey: [orgId, 'notes', residentId],
    enabled: !!orgId,
    queryFn: () =>
      select<CareNote[]>(
        supabase
          .from('care_notes')
          .select('id, kind, body, occurred_at, created_at, author_id, amends_note_id, resident_id')
          .eq('resident_id', residentId)
          .order('occurred_at', { ascending: false })
          .limit(100),
      ),
  });
}

export function useNote(orgId: string | undefined, noteId: string) {
  return useQuery({
    queryKey: [orgId, 'note', noteId],
    enabled: !!orgId,
    queryFn: () =>
      select<CareNote | null>(
        supabase.from('care_notes').select('id, kind, body, occurred_at, created_at, author_id, amends_note_id, resident_id').eq('id', noteId).maybeSingle(),
      ),
  });
}

export function useDueDoses(orgId: string | undefined, siteId: string | undefined, now: Date) {
  const from = new Date(now.getTime() - 3 * 3_600_000).toISOString();
  const to = new Date(now.getTime() + 3 * 3_600_000).toISOString();
  return useQuery({
    queryKey: [orgId, 'doses', siteId, from.slice(0, 13)],
    enabled: !!orgId && !!siteId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const rows = await rpc<
        { order_id: string; resident_id: string; drug_name: string; dose: string; route: string; scheduled_for: string; status: DueDose['status'] }[]
      >('due_doses', { p_site: siteId, p_from: from, p_to: to });
      return rows.map(
        (r): DueDose => ({
          orderId: r.order_id,
          residentId: r.resident_id,
          drugName: r.drug_name,
          dose: r.dose,
          route: r.route,
          scheduledFor: new Date(r.scheduled_for).toISOString(),
          status: r.status,
        }),
      );
    },
  });
}

export function useAuditTrail(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [orgId, 'audit'],
    enabled: !!orgId && enabled,
    queryFn: () =>
      select<AuditEvent[]>(
        supabase.from('audit_events').select('id, action, actor_id, entity_id, at').eq('org_id', orgId as string).order('at', { ascending: false }).limit(100),
      ),
  });
}

export function useStaffNames(orgId: string | undefined) {
  return useQuery({
    queryKey: [orgId, 'staff-names'],
    enabled: !!orgId,
    queryFn: async () => {
      const rows = await select<{ user_id: string; full_name: string | null }[]>(supabase.from('profiles').select('user_id, full_name'));
      return new Map(rows.map((r) => [r.user_id, r.full_name ?? 'Staff member']));
    },
  });
}
