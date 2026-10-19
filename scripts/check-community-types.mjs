// Type-aware checks for the sync modules covered by community review.
import { ESLint } from 'eslint';
const files = ['src/ViewBindings.ts', 'src/client/provider.ts', 'src/permanentUserData.ts', 'src/storage/local-document-store.ts', 'src/webPublish/pushFolderContentToServer.ts'];
const names = ['no-unsafe-argument', 'no-unsafe-assignment', 'no-unsafe-return', 'no-unsafe-call', 'no-unsafe-member-access', 'no-redundant-type-constituents', 'no-unnecessary-type-assertion', 'no-misused-promises', 'unbound-method'];
const lint = new ESLint({overrideConfig: {languageOptions: {parserOptions: {project: './tsconfig.json', tsconfigRootDir: process.cwd()}}, rules: Object.fromEntries(names.map(name => ['@typescript-eslint/' + name, 'error']))}});
const results = await lint.lintFiles(files);
console.log((await lint.loadFormatter('stylish')).format(results));
console.log(`Typed diagnostics: ${results.reduce((n,r)=>n+r.errorCount,0)}`);
process.exitCode = results.some(r=>r.errorCount) ? 1 : 0;
