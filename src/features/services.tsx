import type PostHog from 'posthog-react-native';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import type { Analytics } from '@/core/analytics/events';
import type { QueueState } from '@/core/offline/queue';
import { createAnalytics, createPostHog, FLAGS, isFlagOn } from '@/platform/analytics';
import { flushWhenOnline, offlineQueue } from '@/platform/offline';

type Services = {
  analytics: Analytics;
  posthog: PostHog | undefined;
  queue: typeof offlineQueue;
  queueState: QueueState;
  aiHandoffFlag: boolean;
};

const ServicesContext = createContext<Services | null>(null);

/** The one place the app's integrations are created. Screens ask for them here. */
export function ServicesProvider({ children }: { children: ReactNode }) {
  const [posthog] = useState(createPostHog);
  const [analytics] = useState(() => createAnalytics(posthog));
  const [queueState, setQueueState] = useState<QueueState>({ pending: [], failed: [] });
  const [aiHandoffFlag, setAiHandoffFlag] = useState(() => isFlagOn(posthog, FLAGS.aiHandoff));

  useEffect(() => {
    void offlineQueue.load().then(setQueueState);
    const unsubscribeQueue = offlineQueue.subscribe(setQueueState);
    const unsubscribeNet = flushWhenOnline((sent, failed) => analytics.track({ name: 'offline_queue_flushed', properties: { sent, failed } }));
    return () => {
      unsubscribeQueue();
      unsubscribeNet();
    };
  }, [analytics]);

  useEffect(() => {
    if (!posthog) return;
    return posthog.onFeatureFlags(() => setAiHandoffFlag(isFlagOn(posthog, FLAGS.aiHandoff)));
  }, [posthog]);

  return (
    <ServicesContext.Provider value={{ analytics, posthog, queue: offlineQueue, queueState, aiHandoffFlag }}>{children}</ServicesContext.Provider>
  );
}

export function useServices(): Services {
  const value = useContext(ServicesContext);
  if (!value) throw new Error('useServices must be used inside ServicesProvider');
  return value;
}
