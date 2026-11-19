import * as Crypto from 'expo-crypto';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { Button, Card, Chips, ErrorNotice, Field, Muted, Screen, Title } from '@/components/ui';
import { toAppError, type AppError } from '@/core/errors';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';
import { useSite } from '@/features/site';
import { invokeFunction } from '@/lib/functions';
import { sendQueued } from '@/platform/offline';

type Draft = { summary: string; follow_ups: { resident: string; resident_id: string | null; action: string }[]; note_count: number };
type Item = { residentId: string; resident: string; action: string; original: string };

const WINDOWS = ['Last 8 hours', 'Last 12 hours'] as const;

/**
 * AI-drafted handoff. The model reads this site's notes (residents appear to
 * it as labels, not names) and suggests a summary and per-resident
 * follow-ups. A person edits each follow-up and posts it under their own name
 * on that resident's record, so no chart ever holds another resident's
 * details. Nothing the model writes is saved on its own.
 */
export default function Handoff() {
  const { site } = useSite();
  const { analytics } = useServices();
  const { active } = useSession();
  const [windowLabel, setWindowLabel] = useState<(typeof WINDOWS)[number]>('Last 8 hours');
  const [summary, setSummary] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(0);
  const [error, setError] = useState<AppError | null>(null);

  async function generate() {
    if (!site) return;
    setBusy(true);
    setError(null);
    setPosted(0);
    const hours = windowLabel === 'Last 8 hours' ? 8 : 12;
    const to = new Date();
    try {
      const draft = await invokeFunction<Draft>('summarize-handoff', {
        site_id: site.id,
        from: new Date(to.getTime() - hours * 3_600_000).toISOString(),
        to: to.toISOString(),
      });
      setSummary(draft.summary);
      setItems(
        draft.follow_ups
          .filter((f): f is Draft['follow_ups'][number] & { resident_id: string } => !!f.resident_id)
          .map((f) => ({ residentId: f.resident_id, resident: f.resident, action: f.action, original: f.action })),
      );
      analytics.track({ name: 'handoff_draft_requested', properties: { note_count: draft.note_count } });
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    setBusy(true);
    setError(null);
    try {
      for (const item of items.filter((i) => i.action.trim().length > 0)) {
        await sendQueued({
          kind: 'care_note',
          clientRef: Crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          payload: { residentId: item.residentId, noteKind: 'handoff', body: item.action.trim(), occurredAt: new Date().toISOString() },
        });
      }
      analytics.track({ name: 'handoff_draft_posted', properties: { edited: items.some((i) => i.action !== i.original) } });
      setPosted(items.length);
      setItems([]);
      setSummary(null);
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Shift handoff, {site?.name}</Title>
        <Muted>
          {active?.orgName} has AI drafts turned on. Check every line against the notes before posting. Each follow-up is saved under your name.
        </Muted>
        <Chips onChange={setWindowLabel} options={WINDOWS} value={windowLabel} />
        <Button label="Draft from notes" loading={busy && summary === null} onPress={generate} testID="draft-handoff" />
        {error ? <ErrorNotice error={error} /> : null}
        {posted > 0 ? <Muted>Posted {posted} follow-up(s). The team at this site has been notified.</Muted> : null}
        {summary !== null ? (
          <Card>
            <Title>Summary (not saved)</Title>
            <Muted>{summary || 'No notes in this window.'}</Muted>
          </Card>
        ) : null}
        {items.map((item, index) => (
          <Card key={`${item.residentId}-${index}`}>
            <Field
              label={`Follow-up for ${item.resident}`}
              multiline
              onChangeText={(action) => setItems((all) => all.map((x, i) => (i === index ? { ...x, action } : x)))}
              value={item.action}
            />
          </Card>
        ))}
        {items.length > 0 ? <Button label="Post follow-ups as my handoff notes" loading={busy} onPress={post} /> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({ content: { gap: 12, paddingBottom: 24 } });
