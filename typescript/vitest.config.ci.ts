/**
 * CI vitest config: runs ALL tests (unit + surfpool integration) with coverage.
 * Used in CI after surfpool-sdk-node has been built and linked.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/src/__tests__/*.test.ts'],
        exclude: ['**/integration.test.ts'], // exclude surfpool-service-based tests only
        testTimeout: 30_000,
        globals: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov', 'json-summary'],
            reportsDirectory: 'coverage',
            include: ['packages/*/src/**/*.ts'],
            exclude: ['**/__tests__/**', '**/dist/**', '**/*.test.ts'],
        },
    },
});
