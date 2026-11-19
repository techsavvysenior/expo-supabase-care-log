/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  // supabase/functions/tests run in Deno; supabase/tests run with node --test.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/supabase/'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  // Pure logic is held to a coverage bar. Screens and the thin wrappers around
  // native SDKs are covered by the Maestro flows instead (see docs/test-plan.md).
  collectCoverageFrom: ['src/core/**/*.ts', 'src/lib/chunked-storage.ts', '!src/**/__tests__/**'],
  coverageThreshold: { global: { lines: 90, branches: 75 } },
};
