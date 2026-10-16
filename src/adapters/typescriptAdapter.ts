/**
 * Layer 2 — TypeScript Language Adapter (`src/adapters/typescriptAdapter.ts`).
 * Parses TypeScript/TSX source files into universal modules, exported symbol
 * signatures, and imports using web-tree-sitter (WASM), and evaluates AST queries
 * defined by a Migration Pack.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language, type Node as TSNode } from 'web-tree-sitter';
import ts from 'typescript';
import { type UniversalSymbol } from './types';
import { TreeSitterQueryAdapter } from './treeSitterAdapter';

const require = createRequire(import.meta.url);

export class TypeScriptAdapter extends TreeSitterQueryAdapter {
  readonly language = 'typescript';

  private tsLang: Language | null = null;
  private tsxLang: Language | null = null;
  private tsConfigCache = new Map<string, { baseUrl?: string; paths?: Record<string, string[]> }>();

  private getTsConfig(repoRoot: string): { baseUrl?: string; paths?: Record<string, string[]> } {
    let cached = this.tsConfigCache.get(repoRoot);
    if (cached) return cached;

    const tsConfigPath = join(repoRoot, 'tsconfig.json');
    if (existsSync(tsConfigPath)) {
      try {
        const text = readFileSync(tsConfigPath, 'utf8');
        const parsed = ts.parseConfigFileTextToJson(tsConfigPath, text);
        const opts = parsed.config?.compilerOptions ?? {};
        cached = {
          baseUrl: opts.baseUrl,
          paths: opts.paths,
        };
      } catch {
        cached = {};
      }
    } else {
      cached = {};
    }

    this.tsConfigCache.set(repoRoot, cached);
    return cached;
  }

  async init(): Promise<void> {
    if (this.parser && this.tsLang && this.tsxLang) return;
    await Parser.init();
    const tsWasm = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
    const tsxWasm = require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm');

    this.tsLang = await Language.load(tsWasm);
    this.tsxLang = await Language.load(tsxWasm);
    this.parser = new Parser();
    this.parser.setLanguage(this.tsLang);
  }

  protected getLanguageForPath(path: string): Language {
    if (!this.tsLang || !this.tsxLang) {
      throw new Error('TypeScriptAdapter not initialized. Call init() first.');
    }
    return path.endsWith('.tsx') || path.endsWith('.jsx') ? this.tsxLang : this.tsLang;
  }

  async findSourceFiles(
    repoRoot: string,
    sourceGlobs: { include: string[]; exclude?: string[] } = { include: ['src/**/*.ts'] },
  ): Promise<string[]> {
    const files: string[] = [];
    const includes = sourceGlobs.include ?? ['src/**/*.ts'];
    const excludes = sourceGlobs.exclude ?? ['**/node_modules/**', '**/*.d.ts'];

    const globToRegex = (glob: string) => {
      const re = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*');
      return new RegExp(`^${re}$`);
    };

    const includeRegexes = includes.map(globToRegex);
    const excludeRegexes = excludes.map(globToRegex);
    const PRUNED_DIR_NAMES = new Set(['node_modules', '.git', '.bkb', '.shift', 'dist', 'build', '.next', '.cache', 'coverage']);

    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (PRUNED_DIR_NAMES.has(entry)) continue;

        const full = join(dir, entry);
        const rel = relative(repoRoot, full).split('\\').join('/');
        const isExcluded = excludeRegexes.some((re) => re.test(rel) || re.test(`${rel}/`));
        if (isExcluded) continue;

        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          const isIncluded = includeRegexes.some((re) => re.test(rel));
          if (isIncluded) {
            files.push(rel);
          }
        }
      }
    };

    walk(repoRoot);
    return files.sort();
  }

  protected extractInternalImports(root: TSNode, repoRoot: string, currentFile: string): string[] {
    const rawSpecifiers: string[] = [];

    // Query for import and export sources and CJS require
    for (let i = 0; i < root.childCount; i++) {
      const child = root.child(i);
      if (!child) continue;
      if (child.type === 'import_statement' || child.type === 'export_statement') {
        const sourceNode = child.childForFieldName('source');
        if (sourceNode) {
          const raw = sourceNode.text.replace(/^['"`]|['"`]$/g, '');
          rawSpecifiers.push(raw);
        }
      }
    }

    // Look for CJS require statements
    const findRequires = (node: TSNode) => {
      if (
        node.type === 'call_expression' &&
        node.childForFieldName('function')?.text === 'require'
      ) {
        const args = node.childForFieldName('arguments');
        if (args && args.namedChildCount > 0) {
          const firstArg = args.namedChild(0);
          if (firstArg && firstArg.type === 'string') {
            const raw = firstArg.text.replace(/^['"`]|['"`]$/g, '');
            rawSpecifiers.push(raw);
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) findRequires(c);
      }
    };
    findRequires(root);

    const resolvedSet = new Set<string>();
    const currentDir = dirname(resolve(repoRoot, currentFile));
    const tsConfig = this.getTsConfig(repoRoot);
    const baseDir = tsConfig.baseUrl ? resolve(repoRoot, tsConfig.baseUrl) : repoRoot;

    for (const spec of rawSpecifiers) {
      const candidateBases: string[] = [];

      if (spec.startsWith('./') || spec.startsWith('../')) {
        candidateBases.push(resolve(currentDir, spec));
      } else {
        // 1. Check tsconfig paths mappings (e.g. @/* or @routes/*)
        if (tsConfig.paths) {
          for (const [pattern, targets] of Object.entries(tsConfig.paths)) {
            if (pattern.endsWith('*')) {
              const prefix = pattern.slice(0, -1);
              if (spec.startsWith(prefix)) {
                const subPath = spec.slice(prefix.length);
                for (const target of targets) {
                  const targetPrefix = target.endsWith('*') ? target.slice(0, -1) : target;
                  candidateBases.push(resolve(baseDir, targetPrefix + subPath));
                }
              }
            } else if (spec === pattern) {
              for (const target of targets) {
                candidateBases.push(resolve(baseDir, target));
              }
            }
          }
        }
        // 2. Check tsconfig baseUrl resolution
        if (tsConfig.baseUrl) {
          candidateBases.push(resolve(baseDir, spec));
        }
      }

      if (candidateBases.length === 0) continue;

      const extensions = ['', '.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs'];
      let found = false;

      for (const candidateBase of candidateBases) {
        const baseWithoutJs = candidateBase.replace(/\.(m|c)?jsx?$/, '');
        const basesToTry = candidateBase !== baseWithoutJs ? [candidateBase, baseWithoutJs] : [candidateBase];

        for (const base of basesToTry) {
          for (const ext of extensions) {
            const full = base + ext;
            if (existsSync(full) && statSync(full).isFile()) {
              const rel = relative(repoRoot, full).split('\\').join('/');
              resolvedSet.add(rel);
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (found) break;
      }

      // If relative file doesn't exist on disk yet (e.g. planned import), normalize with .ts
      if (!found && (spec.startsWith('./') || spec.startsWith('../')) && candidateBases[0]) {
        let assumed = relative(repoRoot, candidateBases[0]).split('\\').join('/');
        if (assumed.endsWith('.js') || assumed.endsWith('.mjs') || assumed.endsWith('.cjs')) {
          const assumedTs = assumed.replace(/\.(m|c)?js$/, '.ts');
          if (existsSync(resolve(repoRoot, assumedTs))) {
            assumed = assumedTs;
          }
        }
        if (
          !assumed.endsWith('.ts') &&
          !assumed.endsWith('.tsx') &&
          !assumed.endsWith('.js') &&
          !assumed.endsWith('.mjs') &&
          !assumed.endsWith('.cjs')
        ) {
          assumed += '.ts';
        }
        resolvedSet.add(assumed);
      }
    }

    return [...resolvedSet].sort();
  }

  protected extractExportedSymbols(root: TSNode, modulePath: string): UniversalSymbol[] {
    const symbols: UniversalSymbol[] = [];

    for (let i = 0; i < root.childCount; i++) {
      const child = root.child(i);
      if (!child || child.type !== 'export_statement') continue;

      for (let j = 0; j < child.childCount; j++) {
        const decl = child.child(j);
        if (!decl) continue;

        // 1. export function ...
        if (decl.type === 'function_declaration') {
          const nameNode = decl.childForFieldName('name') ?? decl.namedChildren.find((n) => n?.type === 'identifier');
          if (nameNode) {
            const name = nameNode.text;
            const bodyNode = decl.childForFieldName('body');
            let signature = decl.text;
            if (bodyNode) {
              signature = decl.text.slice(0, bodyNode.startIndex - decl.startIndex).trim();
            }
            symbols.push({
              id: `${modulePath}#{name}`.replace('{name}', name),
              modulePath,
              name,
              kind: 'function',
              signature: `export ${signature}`.trim(),
            });
          }
        }

        // 2. export const / let ...
        else if (decl.type === 'lexical_declaration') {
          for (let k = 0; k < decl.childCount; k++) {
            const sub = decl.child(k);
            if (!sub) continue;
            if (sub.type === 'variable_declarator') {
              const nameNode = sub.childForFieldName('name');
              if (nameNode) {
                const name = nameNode.text;
                const typeNode = sub.childForFieldName('type');
                const valNode = sub.childForFieldName('value');
                let sig = `export const ${name}`;
                if (typeNode) {
                  sig += typeNode.text;
                } else if (valNode && valNode.type === 'arrow_function') {
                  const arrowParams = valNode.childForFieldName('parameters');
                  const arrowReturn = valNode.childForFieldName('return_type');
                  sig += ` = ${arrowParams ? arrowParams.text : '()'}${arrowReturn ? arrowReturn.text : ''}`;
                } else {
                  const valPreview = valNode?.text.slice(0, 40) ?? '';
                  sig += ` = ${valPreview}`;
                }
                symbols.push({
                  id: `${modulePath}#{name}`.replace('{name}', name),
                  modulePath,
                  name,
                  kind: 'variable',
                  signature: sig.trim(),
                });
              }
            }
          }
        }

        // 3. export interface ...
        else if (decl.type === 'interface_declaration') {
          const nameNode = decl.childForFieldName('name');
          if (nameNode) {
            const name = nameNode.text;
            symbols.push({
              id: `${modulePath}#{name}`.replace('{name}', name),
              modulePath,
              name,
              kind: 'type',
              signature: `export ${decl.text}`,
            });
          }
        }

        // 4. export type ...
        else if (decl.type === 'type_alias_declaration') {
          const nameNode = decl.childForFieldName('name');
          if (nameNode) {
            const name = nameNode.text;
            symbols.push({
              id: `${modulePath}#{name}`.replace('{name}', name),
              modulePath,
              name,
              kind: 'type',
              signature: `export ${decl.text}`,
            });
          }
        }

        // 5. export class ...
        else if (decl.type === 'class_declaration') {
          const nameNode = decl.childForFieldName('name');
          if (nameNode) {
            const name = nameNode.text;
            symbols.push({
              id: `${modulePath}#{name}`.replace('{name}', name),
              modulePath,
              name,
              kind: 'class',
              signature: `export class ${name}`,
            });
          }
        }

        // 6. export { a, b as c }
        else if (decl.type === 'export_clause') {
          for (let k = 0; k < decl.childCount; k++) {
            const spec = decl.child(k);
            if (!spec) continue;
            if (spec.type === 'export_specifier') {
              const nameNode = spec.childForFieldName('alias') ?? spec.childForFieldName('name') ?? spec.namedChild(0);
              if (nameNode) {
                const name = nameNode.text;
                symbols.push({
                  id: `${modulePath}#{name}`.replace('{name}', name),
                  modulePath,
                  name,
                  kind: 'variable',
                  signature: `export { ${spec.text} }`,
                });
              }
            }
          }
        }
      }
    }

    return symbols;
  }
}
