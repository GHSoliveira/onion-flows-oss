import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  js.configs.recommended,
  reactHooks.configs.flat.recommended,
  reactRefresh.configs.vite,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^(_|[A-Z])',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^[A-Z_]'
      }],
      'no-empty': 'warn',
      'no-case-declarations': 'warn',
      'react-refresh/only-export-components': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn'
    }
  }
];
