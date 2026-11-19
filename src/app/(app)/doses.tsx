import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Chips, ErrorNotice, Field, Loading, Muted, Screen, Title } from '@/components/ui';
import { toAppError, type AppError } from '@/core/errors';
import { canRecord, doseState, groupByTime, reasonRequired, type DueDose } from '@/core/mar/dose-window';
import { useDueDoses, useResidents } from '@/features/queries';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';
import { useSite } from '@/features/site';
import { sendQueued } from '@/platform/offline';

const STATUSES = ['given', 'refused', 'held'] as const;

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export default function Doses() {
  const { active } = useSession();
  const { site } = useSite();
  const now = useNow();
  const doses = useDueDoses(active?.orgId, site?.id, now);
  const residents = useResidents(active?.orgId, site?.id);

  if (!site || doses.isLoading) return <Loading />;
  const nameOf = (id: string) => {
    const r = residents.data?.find((x) => x.id === id);
    return r ? `${r.first_name} ${r.last_name}` : 'Resident';
  };

  return (
    <Screen>
      <Title>Medication pass, {site.name}</Title>
      <Muted>Three hours either side of now, in the site&apos;s time zone.</Muted>
      {doses.error ? <ErrorNotice error={toAppError(doses.error)} onRetry={() => doses.refetch()} /> : null}
      <ScrollView contentContainerStyle={styles.list}>
        {groupByTime(doses.data ?? []).map((group) => (
          <View key={group.scheduledFor} style={styles.group}>
            <Title>{new Date(group.scheduledFor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: site.timezone })}</Title>
            {group.doses.map((dose) => (
              <DoseCard dose={dose} key={`${dose.orderId}-${dose.scheduledFor}`} now={now} residentName={nameOf(dose.residentId)} />
            ))}
          </View>
        ))}
        {doses.data?.length === 0 ? <Muted>No doses scheduled in this window.</Muted> : null}
      </ScrollView>
    </Screen>
  );
}

function DoseCard({ dose, now, residentName }: { dose: DueDose; now: Date; residentName: string }) {
  const { active } = useSession();
  const { queue, analytics } = useServices();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('given');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const state = doseState(dose, now);

  async function record() {
    setSaving(true);
    setError(null);
    const item = {
      kind: 'dose' as const,
      clientRef: Crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      payload: { orderId: dose.orderId, scheduledFor: dose.scheduledFor, status, reason: reasonRequired(status) ? reason.trim() : null },
    };
    const minutes = Math.round((Date.now() - Date.parse(dose.scheduledFor)) / 60_000);
    try {
      await sendQueued(item);
      analytics.track({ name: 'dose_recorded', properties: { status, offline: false, minutes_from_schedule: minutes } });
      await queryClient.invalidateQueries({ queryKey: [active?.orgId, 'doses'] });
    } catch (caught) {
      const appError = toAppError(caught);
      if (appError.retryable) {
        await queue.enqueue(item);
        analytics.track({ name: 'dose_recorded', properties: { status, offline: true, minutes_from_schedule: minutes } });
      } else {
        setError(appError);
      }
    }
    setSaving(false);
  }

  return (
    <Card>
      <Title>{residentName}</Title>
      <Muted>
        {dose.drugName} {dose.dose}, {dose.route}
      </Muted>
      {state.kind === 'recorded' ? (
        <Badge label={state.status} tone={state.status === 'given' ? 'success' : 'danger'} />
      ) : state.kind === 'not_yet' ? (
        <Muted>Opens in {state.opensInMinutes} min</Muted>
      ) : (
        <>
          {state.kind === 'overdue' ? <Badge label={`${state.minutesLate} min late`} tone="danger" /> : null}
          <Chips onChange={setStatus} options={STATUSES} value={status} />
          {reasonRequired(status) ? <Field label="Reason" onChangeText={setReason} value={reason} /> : null}
          {error ? <ErrorNotice error={error} /> : null}
          <Button
            disabled={!canRecord(state) || (reasonRequired(status) && reason.trim().length < 3)}
            label="Record"
            loading={saving}
            onPress={record}
            testID="record-dose"
          />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { gap: 16, paddingBottom: 24 },
  group: { gap: 8 },
});
