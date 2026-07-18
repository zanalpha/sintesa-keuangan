'use strict';

// Konfigurasi ESLint (flat config, ESLint 9). Ringan & tanpa plugin/paket tambahan.
// Fokus: variabel tak terpakai & gaya. `no-undef` dimatikan agar tak perlu mendaftar
// semua global Node/browser secara manual — referensi tak dikenal ditangkap saat runtime & oleh test.
module.exports = [
  { ignores: ['node_modules/**'] },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'off',
      'no-var': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    // File di public/ dimuat sebagai ES module (<script type="module">) — memakai import/export.
    // Harus di-parse sebagai 'module', bukan 'script', agar ESLint tak melempar parse error.
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'off',
    },
  },
];
