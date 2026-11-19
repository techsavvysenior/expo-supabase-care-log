import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';

import { rpc } from '@/lib/functions';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Asks for permission, gets this device's Expo push token and stores it for
 * the signed-in user. Returns the token, or null when push isn't possible
 * (simulator, permission refused, no EAS project id).
 */
export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Care alerts',
      importance: AndroidImportance.HIGH,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  const status = existing.status === 'granted' ? existing.status : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null;

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await rpc('register_device', { p_token: token, p_platform: Platform.OS === 'ios' ? 'ios' : 'android' });
  return token;
}

/** The deep link a notification carries, e.g. carelog://notes/<id>. */
export function linkFromNotification(response: Notifications.NotificationResponse): string | undefined {
  const url = response.notification.request.content.data?.url;
  return typeof url === 'string' && url.startsWith('carelog://') ? url : undefined;
}
