import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

export default defineConfig(
  // src/lib/data : données embarquées générées (liste de mots de passe), pas du code.
  { ignores: ['dist/**', 'coverage/**', 'src/generated/**', 'node_modules/**', 'src/lib/data/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-console': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'Math.random est interdit : utiliser node:crypto.' },
        { selector: "MemberExpression[property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]", message: 'Requêtes SQL non paramétrées interdites : utiliser $queryRaw / $executeRaw tagués.' },
        { selector: "MemberExpression[object.name='req'][property.name=/^(body|query|params)$/]", message: 'Lire l’entrée validée (endpoint() / res.locals.input), jamais req.body / req.query / req.params.' },
        { selector: "VariableDeclarator[init.name='req'] > ObjectPattern > Property[key.name=/^(body|query|params)$/]", message: 'Lire l’entrée validée (endpoint() / res.locals.input), jamais req.body / req.query / req.params.' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      // Faux positifs systématiques sur les accès indexés typés (Record, tableaux) ; les entrées sont validées par Joi.
      'security/detect-object-injection': 'off',
    },
  },
  {
    // Seuls le middleware de validation et le contrôle d'adhésion (qui valide lui-même orgId au format UUID
    // strict avant toute requête) lisent la requête brute.
    files: ['src/middlewares/validate.ts', 'src/middlewares/requireOrgRole.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='Math'][property.name='random']", message: 'Math.random est interdit : utiliser node:crypto.' },
      ],
    },
  },
  {
    // Outils d'exploitation : chemins fournis par l'opérateur (variables d'environnement), pas par un client HTTP.
    files: ['scripts/**/*.ts'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
);
