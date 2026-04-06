import solanaConfig from '@solana/eslint-config-solana';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '**/__tests__/**', 'demo/**', '**/*.gen.ts'],
  },
  ...solanaConfig,
  {
    rules: {
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
];
