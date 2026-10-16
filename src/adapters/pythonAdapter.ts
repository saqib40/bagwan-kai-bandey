/**
 * Layer 2 — Python Language Adapter (`src/adapters/pythonAdapter.ts`).
 *
 * Parses Python source files into universal modules, exported symbols, and
 * internal import edges using web-tree-sitter (WASM). Inherits the whole
 * language-neutral query engine from `TreeSitterQueryAdapter`; supplies only the
 * grammar, Python import resolution, symbol extraction, and file discovery.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve, relative } from 'node:path';
import { Language, type Node as TSNode } from 'web-tree-sitter';
import { type UniversalSymbol } from './types';
import { TreeSitterQueryAdapter } from './treeSitterAdapter';

const require = createRequire(import.meta.url);

const PYTHON_PRUNED_DIRS = new Set([
  'node_modules',
  '.git',
  '.bkb',
  '.shift',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'dist',
  'build',
  'coverage',
]);

interface ImportSpec {
  /** 0 for absolute imports; N for `from .`/`from ..` relative imports. */
  level: number;
  /** Dotted module path (e.g. `a.b.c`), or null for `from . import x`. */
  module: string | null;
  /** Names imported by a `from ... import` statement. */
  names: string[];
}

export class PythonAdapter extends TreeSitterQueryAdapter {
  readonly language = 'python';

  private pyLang: Language | null = null;

  async init(): Promise<void> {
    if (this.parser && this.pyLang) return;
    const { Parser } = await import('web-tree-sitter');
    await Parser.init();
    this.pyLang = await Language.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm'));
    this.parser = new Parser();
    this.parser.setLanguage(this.pyLang);
  }

  protected probePath(): string {
    return 'module.py';
  }

  protected getLanguageForPath(_path: string): Language {
    if (!this.pyLang) throw new Error('PythonAdapter not initialized. Call init() first.');
    return this.pyLang;
  }

  async findSourceFiles(
    repoRoot: string,
    sourceGlobs: { include: string[]; exclude?: string[] } = { include: ['**/*.py'] },
  ): Promise<string[]> {
    const files: string[] = [];
    const includes = sourceGlobs.include ?? ['**/*.py'];
    const excludes = sourceGlobs.exclude ?? ['**/*.pyi'];

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

    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (PYTHON_PRUNED_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        const rel = relative(repoRoot, full).split('\\').join('/');
        if (excludeRegexes.some((re) => re.test(rel) || re.test(`${rel}/`))) continue;

        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile() && includeRegexes.some((re) => re.test(rel))) {
          files.push(rel);
        }
      }
    };

    walk(repoRoot);
    return files.sort();
  }

  protected extractInternalImports(root: TSNode, repoRoot: string, currentFile: string): string[] {
    const specs: ImportSpec[] = [];

    const collect = (node: TSNode) => {
      if (node.type === 'import_statement') {
        for (const child of node.namedChildren) {
          if (!child) continue;
          if (child.type === 'dotted_name') {
            specs.push({ level: 0, module: child.text, names: [] });
          } else if (child.type === 'aliased_import') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) specs.push({ level: 0, module: nameNode.text, names: [] });
          }
        }
      } else if (node.type === 'import_from_statement') {
        const moduleNode = node.childForFieldName('module_name');
        let level = 0;
        let module: string | null = null;
        if (moduleNode) {
          if (moduleNode.type === 'relative_import') {
            level = (moduleNode.text.match(/^\.+/) ?? [''])[0].length;
            const dotted = moduleNode.namedChildren.find((n) => n?.type === 'dotted_name');
            module = dotted ? dotted.text : null;
          } else {
            module = moduleNode.text;
          }
        }
        const names: string[] = [];
        for (const child of node.namedChildren) {
          if (!child || child === moduleNode) continue;
          if (child.type === 'dotted_name') names.push(child.text);
          else if (child.type === 'aliased_import') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) names.push(nameNode.text);
          }
        }
        specs.push({ level, module, names });
      }

      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) collect(c);
      }
    };
    collect(root);

    const resolved = new Set<string>();

    const tryAdd = (candidateBase: string) => {
      const candidates = [`${candidateBase}.py`, join(candidateBase, '__init__.py')];
      for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          resolved.add(relative(repoRoot, candidate).split('\\').join('/'));
          return;
        }
      }
    };

    for (const spec of specs) {
      if (spec.level > 0) {
        let base = dirname(resolve(repoRoot, currentFile));
        for (let i = 1; i < spec.level; i++) base = dirname(base);

        if (spec.module) {
          const modulePath = join(base, ...spec.module.split('.'));
          tryAdd(modulePath);
          for (const name of spec.names) tryAdd(join(modulePath, name));
        } else {
          for (const name of spec.names) tryAdd(join(base, name));
        }
      } else if (spec.module) {
        const modulePath = join(repoRoot, ...spec.module.split('.'));
        tryAdd(modulePath);
        for (const name of spec.names) tryAdd(join(modulePath, name));
      }
    }

    return [...resolved].sort();
  }

  protected extractExportedSymbols(root: TSNode, modulePath: string): UniversalSymbol[] {
    const symbols: UniversalSymbol[] = [];

    const signatureOf = (node: TSNode): string => {
      const body = node.childForFieldName('body');
      if (body) return node.text.slice(0, body.startIndex - node.startIndex).trim();
      return node.text.trim();
    };

    const pushFunction = (node: TSNode) => {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      symbols.push({
        id: `${modulePath}#${nameNode.text}`,
        modulePath,
        name: nameNode.text,
        kind: 'function',
        signature: signatureOf(node),
      });
    };

    const pushClass = (node: TSNode) => {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      symbols.push({
        id: `${modulePath}#${nameNode.text}`,
        modulePath,
        name: nameNode.text,
        kind: 'class',
        signature: signatureOf(node),
      });

      const body = node.childForFieldName('body');
      if (!body) return;
      for (const member of body.namedChildren) {
        if (!member) continue;
        const decl = member.type === 'decorated_definition'
          ? member.childForFieldName('definition') ?? member
          : member;
        if (decl.type === 'function_definition') pushFunction(decl);
      }
    };

    for (const child of root.namedChildren) {
      if (!child) continue;
      const decl = child.type === 'decorated_definition'
        ? child.childForFieldName('definition') ?? child
        : child;
      if (decl.type === 'function_definition') pushFunction(decl);
      else if (decl.type === 'class_definition') pushClass(decl);
    }

    return symbols;
  }
}
