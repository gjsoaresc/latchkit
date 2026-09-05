import eslint from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['src/**/*.js', 'web/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none' }],
      'no-unsafe-finally': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
