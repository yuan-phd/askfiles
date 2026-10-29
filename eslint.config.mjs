import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

// Web platform names used by the renderer pages and by the code Playwright runs inside the page.
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  URLSearchParams: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  Response: 'readonly',
  ReadableStream: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  AbortController: 'readonly',
  CustomEvent: 'readonly',
};

export default tseslint.config(
  { ignores: ['upstream/**', 'dist/**', 'out/**', 'release/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
  },
  {
    files: ['src/renderer/**/*.js', 'test/e2e/**/*.{js,mjs,mts}'],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
  },
  {
    files: ['**/*.ts', '**/*.mts'],
    extends: [tseslint.configs.recommended],
  },
);
