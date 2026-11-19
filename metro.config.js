// Sentry's Metro config adds Debug IDs to bundles and source maps, so
// production stack traces map back to the TypeScript source.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

module.exports = getSentryExpoConfig(__dirname);
