import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { toAppError } from '@/core/errors';
import { capabilitiesOf, isStaffRole, type Capabilities, type StaffRole } from '@/core/roles';
import { clearOfflineQueue } from '@/platform/offline';
import { identifyForCrashes } from '@/platform/sentry';
import { supabase } from '@/lib/supabase';

export type Membership = { orgId: string; orgName: string; role: StaffRole; aiEnabled: boolean };

type SessionValue = {
  /** undefined while the stored session is loading. */
  session: Session | null | undefined;
  memberships: Membership[];
  active: Membership | null;
  can: Capabilities;
  switchOrganization(orgId: string): void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, fullName: string): Promise<void>;
  signOut(): Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Who is signed in, which care providers they belong to, and their role in
 * the one they are working in now. A person can work for more than one
 * provider; switching clears cached data so nothing from one provider is
 * shown under another.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;
  useEffect(() => identifyForCrashes(userId), [userId]);

  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships', userId],
    enabled: !!userId,
    queryFn: async (): Promise<Membership[]> => {
      const { data, error } = await supabase
        .from('memberships')
        .select('org_id, role, organizations(name, ai_summaries_enabled)')
        .eq('user_id', userId as string);
      if (error) throw toAppError(error);
      return (data ?? [])
        .filter((row) => isStaffRole(row.role))
        .map((row) => {
          const org = row.organizations as unknown as { name: string; ai_summaries_enabled: boolean } | null;
          return { orgId: row.org_id, orgName: org?.name ?? '', role: row.role as StaffRole, aiEnabled: org?.ai_summaries_enabled ?? false };
        });
    },
  });

  const active = memberships.find((m) => m.orgId === activeOrgId) ?? memberships[0] ?? null;

  const switchOrganization = useCallback(
    (orgId: string) => {
      setActiveOrgId(orgId);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'memberships' });
    },
    [queryClient],
  );

  const value = useMemo<SessionValue>(
    () => ({
      session,
      memberships,
      active,
      can: capabilitiesOf(active?.role),
      switchOrganization,
      signIn: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw toAppError(error);
      },
      signUp: async (email, password, fullName) => {
        const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
        if (error) throw toAppError(error);
      },
      signOut: async () => {
        await clearOfflineQueue();
        queryClient.clear();
        await supabase.auth.signOut();
      },
    }),
    [session, memberships, active, switchOrganization, queryClient],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
