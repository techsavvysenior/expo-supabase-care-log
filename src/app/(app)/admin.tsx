import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';

import { Button, Card, Chips, colors, ErrorNotice, Field, Muted, Screen, Title } from '@/components/ui';
import { toAppError, type AppError } from '@/core/errors';
import { STAFF_ROLES, type StaffRole } from '@/core/roles';
import { useAuditTrail, useStaffNames } from '@/features/queries';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';
import { useSite } from '@/features/site';
import { invokeFunction } from '@/lib/functions';

export default function Admin() {
  const { active, can } = useSession();
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {can.manageStaff ? <InviteStaff /> : null}
        {can.manageSites ? <SitesMap /> : null}
        {can.readAuditTrail ? <AuditTrail orgId={active?.orgId} /> : null}
      </ScrollView>
    </Screen>
  );
}

function InviteStaff() {
  const { active } = useSession();
  const { sites } = useSite();
  const { analytics } = useServices();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('caregiver');
  const [siteName, setSiteName] = useState(sites[0]?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  async function invite() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const siteIds = role === 'caregiver' ? sites.filter((s) => s.name === siteName).map((s) => s.id) : [];
      await invokeFunction('invite-staff', { org_id: active?.orgId, email: email.trim(), role, site_ids: siteIds });
      analytics.track({ name: 'staff_invited', properties: { role } });
      setDone(`Invitation emailed to ${email.trim()}.`);
      setEmail('');
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Title>Invite staff</Title>
      <Field inputMode="email" label="Email" onChangeText={setEmail} value={email} />
      <Chips onChange={setRole} options={STAFF_ROLES} value={role} />
      {role === 'caregiver' && sites.length > 0 ? <Chips onChange={setSiteName} options={sites.map((s) => s.name)} value={siteName} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {done ? <Muted>{done}</Muted> : null}
      <Button disabled={!email.includes('@')} label="Send invitation" loading={busy} onPress={invite} />
    </Card>
  );
}

function SitesMap() {
  const { active } = useSession();
  const { sites } = useSite();
  const { analytics } = useServices();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const located = sites.filter((s) => s.latitude !== null && s.longitude !== null);

  async function geocode(siteId: string, acceptPartial = false) {
    setBusyId(siteId);
    setError(null);
    setMessage(null);
    try {
      const result = await invokeFunction<{ saved: boolean; needs_confirmation?: boolean; formatted_address: string; partial_match?: boolean }>(
        'geocode-site',
        { site_id: siteId, accept_partial: acceptPartial },
      );
      if (result.needs_confirmation) {
        setMessage(`Google found only an approximate match: ${result.formatted_address}. Tap "Use approximate" if that is right.`);
      } else {
        analytics.track({ name: 'site_geocoded', properties: { partial_match: result.partial_match === true } });
        setMessage(`Pinned at ${result.formatted_address}.`);
        await queryClient.invalidateQueries({ queryKey: [active?.orgId, 'sites'] });
      }
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <Title>Sites</Title>
      {located.length > 0 ? (
        <MapView
          initialRegion={{ latitude: located[0].latitude as number, longitude: located[0].longitude as number, latitudeDelta: 0.5, longitudeDelta: 0.5 }}
          provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
          style={styles.map}>
          {located.map((s) => (
            <Marker coordinate={{ latitude: s.latitude as number, longitude: s.longitude as number }} key={s.id} title={s.name} />
          ))}
        </MapView>
      ) : (
        <Muted>No site is on the map yet.</Muted>
      )}
      {sites.map((s) => (
        <Card key={s.id}>
          <Text style={styles.siteName}>{s.name}</Text>
          <Button label={s.latitude ? 'Look up again' : 'Find on map'} loading={busyId === s.id} onPress={() => geocode(s.id)} variant="secondary" />
          {message?.includes('approximate') && busyId === null ? (
            <Button label="Use approximate" onPress={() => geocode(s.id, true)} variant="secondary" />
          ) : null}
        </Card>
      ))}
      {message ? <Muted>{message}</Muted> : null}
      {error ? <ErrorNotice error={error} /> : null}
    </Card>
  );
}

function AuditTrail({ orgId }: { orgId: string | undefined }) {
  const audit = useAuditTrail(orgId, true);
  const names = useStaffNames(orgId);
  return (
    <Card>
      <Title>Audit trail</Title>
      <Muted>Every chart opened, note written and dose recorded. Entries can&apos;t be changed or deleted.</Muted>
      {audit.error ? <ErrorNotice error={toAppError(audit.error)} onRetry={() => audit.refetch()} /> : null}
      {(audit.data ?? []).map((event) => (
        <Text key={event.id} style={styles.audit}>
          {new Date(event.at).toLocaleString()} · {event.action} · {event.actor_id ? (names.data?.get(event.actor_id) ?? 'Staff member') : 'System'}
        </Text>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, paddingBottom: 24 },
  map: { borderRadius: 10, height: 220, width: '100%' },
  siteName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  audit: { color: colors.text, fontSize: 13 },
});
