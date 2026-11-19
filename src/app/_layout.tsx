import { QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { Loading } from '@/components/ui';
import { ServicesProvider } from '@/features/services';
import { SessionProvider, useSession } from '@/features/session';
import { createQueryClient } from '@/lib/query-client';
import { linkFromNotification, registerForPush } from '@/platform/push';
import { initSentry, wrapRoot } from '@/platform/sentry';

initSentry();

function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ServicesProvider>
          <StatusBar style="dark" />
          <Navigator />
        </ServicesProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Navigator() {
  const { session } = useSession();
  const router = useRouter();
  const signedIn = !!session;

  useEffect(() => {
    if (!signedIn) return;
    registerForPush().catch(() => undefined);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const url = linkFromNotification(response);
      if (url) router.push(url.replace('carelog://', '/') as never);
    });
    return () => subscription.remove();
  }, [signedIn, router]);

  if (session === undefined) return <Loading />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Screen name="invite" options={{ headerShown: true, title: 'Invitation' }} />
    </Stack>
  );
}

export default wrapRoot(RootLayout);
