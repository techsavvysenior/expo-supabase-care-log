import { createContext, useContext, useState, type ReactNode } from 'react';

import { useSites, type Site } from '@/features/queries';
import { useSession } from '@/features/session';

type SiteValue = { sites: Site[]; site: Site | undefined; selectSite(id: string): void; loading: boolean };

const SiteContext = createContext<SiteValue | null>(null);

/** The house the person is working in now, shared by every tab. */
export function SiteProvider({ children }: { children: ReactNode }) {
  const { active } = useSession();
  const { data: sites = [], isLoading } = useSites(active?.orgId);
  // Remembered per organization, so switching providers starts at that provider's first site.
  const [choice, setChoice] = useState<{ orgId: string; siteId: string } | null>(null);
  const selectedId = choice && choice.orgId === active?.orgId ? choice.siteId : undefined;

  const site = sites.find((s) => s.id === selectedId) ?? sites[0];
  const selectSite = (siteId: string) => active && setChoice({ orgId: active.orgId, siteId });
  return <SiteContext.Provider value={{ sites, site, selectSite, loading: isLoading }}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteValue {
  const value = useContext(SiteContext);
  if (!value) throw new Error('useSite must be used inside SiteProvider');
  return value;
}
