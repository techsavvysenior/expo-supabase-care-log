import { useQueryClient } from '@tanstack/react-query';
import { Tabs } from 'expo-router';
import { useState } from 'react';

import { Button, colors, ErrorNotice, Field, Muted, Screen, Title } from '@/components/ui';
import { toAppError, type AppError } from '@/core/errors';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';
import { SiteProvider } from '@/features/site';
import { rpc } from '@/lib/functions';

/**
 * Tabs follow the person's role in the active organization. Hiding a tab is a
 * convenience only: row-level security refuses the same reads and writes.
 */
export default function AppLayout() {
  const { active, can } = useSession();
  const { queueState, aiHandoffFlag } = useServices();

  if (!active) return <NoOrganization />;

  const showHandoff = aiHandoffFlag && active.aiEnabled && can.writeCareNotes;
  const showAdmin = can.manageStaff || can.readAuditTrail;

  return (
    <SiteProvider>
      <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary }}>
        <Tabs.Screen name="index" options={{ title: 'Residents', tabBarBadge: queueState.pending.length || undefined }} />
        <Tabs.Screen name="doses" options={{ title: 'Medications', href: can.recordDoses ? undefined : null }} />
        <Tabs.Screen name="handoff" options={{ title: 'Handoff', href: showHandoff ? undefined : null }} />
        <Tabs.Screen name="admin" options={{ title: can.manageStaff ? 'Admin' : 'Audit', href: showAdmin ? undefined : null }} />
        <Tabs.Screen name="resident/[id]" options={{ href: null, title: 'Resident' }} />
        <Tabs.Screen name="notes/[id]" options={{ href: null, title: 'Note' }} />
      </Tabs>
    </SiteProvider>
  );
}

/** First run: join through an invitation link, or start a new organization as its admin. */
function NoOrganization() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await rpc<string>('create_organization', { p_name: name.trim() });
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>No care team yet</Title>
      <Muted>If your employer uses Care Log, open the invitation link from your email on this phone.</Muted>
      <Muted>Setting up Care Log for your organization? Create it here and you will be its first admin.</Muted>
      <Field label="Organization name" onChangeText={setName} value={name} />
      {error ? <ErrorNotice error={error} /> : null}
      <Button disabled={name.trim().length < 2} label="Create organization" loading={busy} onPress={create} />
    </Screen>
  );
}
