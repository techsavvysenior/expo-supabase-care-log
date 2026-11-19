import { router } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Chips, colors, EmptyState, ErrorNotice, Loading, Muted, Screen, Title } from '@/components/ui';
import { toAppError } from '@/core/errors';
import { useResidents } from '@/features/queries';
import { useServices } from '@/features/services';
import { useSession } from '@/features/session';
import { useSite } from '@/features/site';

export default function Residents() {
  const { active, memberships, switchOrganization, signOut } = useSession();
  const { sites, site, selectSite, loading } = useSite();
  const { queueState, analytics } = useServices();
  const residents = useResidents(active?.orgId, site?.id);

  if (loading) return <Loading />;
  if (!site) return <EmptyState body="An admin needs to add a site, or assign you to one." title="No sites yet" />;

  return (
    <Screen>
      {memberships.length > 1 ? (
        <Chips
          onChange={(name) => {
            const next = memberships.find((m) => m.orgName === name);
            if (next) {
              switchOrganization(next.orgId);
              analytics.track({ name: 'organization_switched' });
            }
          }}
          options={memberships.map((m) => m.orgName)}
          value={active?.orgName ?? ''}
        />
      ) : null}
      {sites.length > 1 ? (
        <Chips onChange={(name) => selectSite(sites.find((s) => s.name === name)?.id ?? site.id)} options={sites.map((s) => s.name)} value={site.name} />
      ) : (
        <Title>{site.name}</Title>
      )}

      {queueState.pending.length > 0 ? (
        <Muted>{queueState.pending.length} saved on this phone, waiting for a connection.</Muted>
      ) : null}
      {queueState.failed.length > 0 ? (
        <Card style={styles.warning}>
          <Text style={styles.warningText}>{queueState.failed.length} entries could not be saved. Open the resident to review them.</Text>
        </Card>
      ) : null}

      {residents.error ? <ErrorNotice error={toAppError(residents.error)} onRetry={() => residents.refetch()} /> : null}
      <FlatList
        contentContainerStyle={styles.list}
        data={residents.data ?? []}
        keyExtractor={(r) => r.id}
        ListEmptyComponent={residents.isLoading ? <Loading /> : <Muted>No residents at this site.</Muted>}
        onRefresh={() => residents.refetch()}
        refreshing={residents.isRefetching}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              analytics.track({ name: 'resident_opened', properties: { from: 'list' } });
              router.push(`/resident/${item.id}`);
            }}>
            <Card>
              <Title>
                {item.first_name} {item.last_name}
              </Title>
              <Muted>{item.room ? `Room ${item.room}` : 'No room set'}</Muted>
            </Card>
          </Pressable>
        )}
      />
      <View>
        <Button label="Sign out" onPress={signOut} variant="secondary" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8, paddingBottom: 24 },
  warning: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerSurface },
  warningText: { color: colors.danger },
});
