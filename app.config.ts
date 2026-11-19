import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Native config. Keys that differ per environment come from the build
 * environment (EAS environment variables or a local .env), so nothing
 * private is committed.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Care Log',
  slug: 'expo-supabase-care-log',
  version: '1.0.0',
  orientation: 'portrait',
  scheme: 'carelog',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.example.carelog',
  },
  android: {
    package: 'com.example.carelog',
    // Care records should not end up in a cloud backup of the phone.
    allowBackup: false,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-notifications', { color: '#0B6E6E' }],
    ['expo-splash-screen', { backgroundColor: '#F6F7F9' }],
    ['react-native-maps', { androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_KEY ?? '' }],
    [
      '@sentry/react-native/expo',
      {
        url: 'https://sentry.io/',
        organization: process.env.SENTRY_ORG ?? 'example-org',
        project: process.env.SENTRY_PROJECT ?? 'care-log',
      },
    ],
  ],
  extra: {
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
  experiments: { typedRoutes: true, reactCompiler: true },
});
