import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Button, ErrorNotice, Muted, Screen, Title } from '@/components/ui';
import { toAppError, type AppError } from '@/core/errors';
import { useSession } from '@/features/session';
import { rpc } from '@/lib/functions';

/** Opened from the emailed link: carelog://invite?token=... */
export default function AcceptInvitation() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { session, switchOrganization } = useSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  if (!session) {
    return (
      <Screen>
        <Title>Sign in first</Title>
        <Muted>Sign in or create an account with the email address the invitation was sent to, then open the link again.</Muted>
        <Button label="Go to sign in" onPress={() => router.replace('/sign-in')} />
      </Screen>
    );
  }

  async function accept() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const orgId = await rpc<string>('accept_invitation', { p_token: token });
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
      switchOrganization(orgId);
      router.replace('/');
    } catch (caught) {
      setError(toAppError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Join your care team</Title>
      <Muted>Accepting adds you to the organization with the role your admin chose.</Muted>
      {error ? <ErrorNotice error={error} /> : null}
      <Button disabled={!token} label="Accept invitation" loading={busy} onPress={accept} />
    </Screen>
  );
}
