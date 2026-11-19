import { router, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import { Badge, Button, Card, colors, ErrorNotice, Loading, Muted, Screen } from '@/components/ui';
import { toAppError } from '@/core/errors';
import { useNote } from '@/features/queries';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';

/**
 * Where a push or email lands (carelog://notes/<id>). The notification itself
 * said nothing clinical; the note is read here, through row-level security.
 */
export default function NoteFromNotification() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { active } = useSession();
  const { analytics } = useServices();
  const note = useNote(active?.orgId, id);

  if (note.isLoading) return <Loading />;
  if (note.error) return <ErrorNotice error={toAppError(note.error)} onRetry={() => note.refetch()} />;
  if (!note.data) {
    return (
      <Screen>
        <Muted>This note isn&apos;t available to you. It may belong to a site you aren&apos;t assigned to.</Muted>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <Badge label={note.data.kind} tone={note.data.kind === 'incident' ? 'danger' : 'neutral'} />
        <Muted>{new Date(note.data.occurred_at).toLocaleString()}</Muted>
        <Text style={{ color: colors.text, fontSize: 15 }}>{note.data.body}</Text>
      </Card>
      <Button
        label="Open resident"
        onPress={() => {
          analytics.track({ name: 'resident_opened', properties: { from: 'notification' } });
          router.push(`/resident/${note.data?.resident_id}`);
        }}
      />
    </Screen>
  );
}
