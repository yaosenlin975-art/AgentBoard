/**
 * CR-11：ESLint 最小门禁（flat config）。
 * 只开三条规则：no-explicit-any / no-unused-vars / eqeqeq(null 例外)；
 * 存量违规由 scripts/eslint-baseline.json 冻结（scripts/run-lint.mjs 比对），不要求一次清零。
 * 不做类型感知 lint（parserOptions.project 不开）：这三条规则不需要类型信息，保持 prebuild 秒级。
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      '.agentboard/**',
      '.logs/**',
      '.tmp/**',
    ],
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    extends: [tseslint.configs.base],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
    },
  },
);
