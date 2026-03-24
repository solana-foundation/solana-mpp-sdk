import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/src/__tests__/anchor-channel.test.ts'],
        testTimeout: 120_000,
        fileParallelism: false,
        maxWorkers: 1,
        globals: true,
    },
});
