import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Badge, Button, Card, Chips, colors, ErrorNotice, Field, Loading, Muted, Screen, Title } from '@/components/ui';
import { toAppError, type AppError } from '@/core/errors';
import { useNotes, useResident, useStaffNames, type CareNote } from '@/features/queries';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';
import { sendQueued } from '@/platform/offline';

const KINDS = ['observation', 'incident', 'handoff'] as const;

export default function ResidentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { active, can } = useSession();
  const { queue, queueState, analytics } = useServices();
  const queryClient = useQueryClient();
  const resident = useResident(active?.orgId, id);
  const notes = useNotes(active?.orgId, id);
  const names = useStaffNames(active?.orgId);

  const [kind, setKind] = useState<(typeof KINDS)[number]>('observation');
  const [body, setBody] = useState('');
  const [correcting, setCorrecting] = useState<CareNote | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  if (resident.isLoading) return <Loading />;
  if (resident.error || !resident.data) {
    return (
      <Screen>
        <ErrorNotice error={toAppError(resident.error ?? new Error('FORBIDDEN'))} />
      </Screen>
    );
  }

  const queuedHere = queueState.pending.filter((p) => p.kind === 'care_note' && p.payload.residentId === id);
  const failedHere = queueState.failed.filter((p) => p.kind === 'care_note' && p.payload.residentId === id);

  async function save() {
    setSaving(true);
    setError(null);
    // The client_ref is fixed when Save is pressed. Every retry, online or
    // from the offline queue, sends the same one, so the note is written once.
    const item = {
      kind: 'care_note' as const,
      clientRef: Crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      payload: {
        residentId: id,
        noteKind: correcting ? 'correction' : kind,
        body: body.trim(),
        occurredAt: new Date().toISOString(),
        amends: correcting?.id ?? null,
      },
    };
    try {
      await sendQueued(item);
      analytics.track({ name: 'care_note_saved', properties: { kind: item.payload.noteKind, offline: false } });
      await queryClient.invalidateQueries({ queryKey: [active?.orgId, 'notes', id] });
    } catch (caught) {
      const appError = toAppError(caught);
      if (!appError.retryable) {
        setError(appError);
        setSaving(false);
        return;
      }
      await queue.enqueue(item);
      analytics.track({ name: 'care_note_saved', properties: { kind: item.payload.noteKind, offline: true } });
    }
    setBody('');
    setCorrecting(null);
    setSaving(false);
  }

  return (
    <Screen>
      <Title>
        {resident.data.first_name} {resident.data.last_name}
      </Title>
      <Muted>
        Born {resident.data.date_of_birth}
        {resident.data.room ? ` · Room ${resident.data.room}` : ''}
      </Muted>

      {can.writeCareNotes ? (
        <Card>
          {correcting ? (
            <Muted>Correcting the note from {new Date(correcting.occurred_at).toLocaleString()}. The original stays in the record.</Muted>
          ) : (
            <Chips onChange={setKind} options={KINDS} value={kind} />
          )}
          <Field label={correcting ? 'Correction' : 'Note'} multiline onChangeText={setBody} testID="note-body" value={body} />
          {error ? <ErrorNotice error={error} /> : null}
          <View style={styles.row}>
            <Button disabled={body.trim().length === 0} label="Save note" loading={saving} onPress={save} style={styles.grow} testID="save-note" />
            {correcting ? <Button label="Cancel" onPress={() => setCorrecting(null)} variant="secondary" /> : null}
          </View>
        </Card>
      ) : null}

      {queuedHere.length > 0 ? <Muted>{queuedHere.length} note(s) saved on this phone, waiting for a connection.</Muted> : null}
      {failedHere.map((f) => (
        <Card key={f.clientRef} style={styles.failed}>
          <Text style={styles.failedText}>Not saved: {f.error}</Text>
          <Button label="Dismiss" onPress={() => queue.dismissFailed(f.clientRef)} variant="secondary" />
        </Card>
      ))}

      {notes.error ? <ErrorNotice error={toAppError(notes.error)} onRetry={() => notes.refetch()} /> : null}
      <FlatList
        contentContainerStyle={styles.list}
        data={notes.data ?? []}
        keyExtractor={(n) => n.id}
        ListEmptyComponent={<Muted>No notes yet.</Muted>}
        renderItem={({ item }) => (
          <Card>
            <View style={styles.row}>
              <Badge label={item.kind} tone={item.kind === 'incident' ? 'danger' : 'neutral'} />
              <Muted>{new Date(item.occurred_at).toLocaleString()}</Muted>
            </View>
            <Text style={styles.body}>{item.body}</Text>
            <Muted>
              {names.data?.get(item.author_id) ?? 'Staff member'}
              {Date.parse(item.created_at) - Date.parse(item.occurred_at) > 3_600_000 ? ' · late entry' : ''}
            </Muted>
            {can.writeCareNotes && item.kind !== 'correction' ? (
              <Button label="Add a correction" onPress={() => setCorrecting(item)} variant="secondary" />
            ) : null}
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  list: { gap: 8, paddingBottom: 24 },
  body: { color: colors.text, fontSize: 15 },
  failed: { backgroundColor: colors.dangerSurface },
  failedText: { color: colors.danger },
});
