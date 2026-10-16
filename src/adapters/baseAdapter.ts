/**
 * Layer 2 — Base Language Adapter (`src/adapters/baseAdapter.ts`).
 *
 * Provides a foundational abstract class with common file discovery,
 * source reading, symbol creation, and parsing utilities.
 * Developers building a new Language Adapter (Python, Go, Rust, Java, etc.)
 * can inherit from this class to eliminate boilerplate.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { lineHasShimMarker, type LanguageAdapter, type ParsedModule, type UniversalSymbol, type MigrationPack, type APIUsage } from './types';

export abstract class BaseLanguageAdapter implements LanguageAdapter {
  abstract readonly language: string;

  /**
   * Optional one-time initialization hook (e.g. loading Tree-sitter WASM grammars).
   */
  async init(): Promise<void> {
    // Default no-op. Subclasses can override if needed.
  }

  /**
   * Parses a single module and extracts universal graph properties.
   */
  abstract parseModule(
    repoRoot: string,
    relativePath: string,
    sourceCode?: string,
    pack?: MigrationPack,
  ): Promise<ParsedModule>;

  /**
   * Discovers source files in the repository conforming to include/exclude glob patterns.
   */
  async findSourceFiles(
    repoRoot: string,
    sourceGlobs: { include: string[]; exclude?: string[] },
  ): Promise<string[]> {
    const results: string[] = [];
    const includeExtensions = this.extractExtensions(sourceGlobs.include);
    const excludePatterns = sourceGlobs.exclude ?? ['**/node_modules/**', '**/dist/**', '**/.git/**'];
    const PRUNED_DIR_NAMES = new Set(['node_modules', '.git', '.bkb', '.shift', 'dist', 'build', '.next', '.cache', 'coverage']);

    const traverse = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (PRUNED_DIR_NAMES.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        const relPath = relative(repoRoot, fullPath);

        // Check excludes
        if (this.isExcluded(relPath, excludePatterns)) {
          continue;
        }

        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile()) {
          if (this.matchesExtension(entry.name, includeExtensions)) {
            results.push(relPath);
          }
        }
      }
    };

    traverse(repoRoot);
    return results.sort();
  }

  /**
   * Helper to read source code from disk.
   */
  protected async readSource(repoRoot: string, relativePath: string): Promise<string> {
    const fullPath = resolve(repoRoot, relativePath);
    return readFileSync(fullPath, 'utf8');
  }

  /**
   * Counts the lines tagged with the dual-compatibility shim marker (`// @bkb-shim` or `// @shift-shim`).
   */
  protected countShimLines(source: string, marker?: string): number {
    return source.split('\n').filter((l) => lineHasShimMarker(l, marker)).length;
  }

  /**
   * Factory helper to construct a compliant ParsedModule object.
   */
  protected createParsedModule(options: {
    path: string;
    fullSource: string;
    imports?: string[];
    symbols?: UniversalSymbol[];
    apiUsages?: APIUsage[];
    invariantSets?: Record<string, string[]>;
    hasSyntaxError?: boolean;
    syntaxErrors?: string[];
    shimMarker?: string;
  }): ParsedModule {
    const shimLineCount = this.countShimLines(options.fullSource, options.shimMarker);

    return {
      path: options.path,
      fullSource: options.fullSource,
      imports: options.imports ?? [],
      symbols: options.symbols ?? [],
      apiUsages: options.apiUsages ?? [],
      invariantSets: options.invariantSets ?? {},
      shimLineCount,
      hasSyntaxError: options.hasSyntaxError ?? false,
      syntaxErrors: options.syntaxErrors ?? [],
    };
  }

  /**
   * Factory helper to create a universal symbol.
   */
  protected createSymbol(
    modulePath: string,
    name: string,
    kind: UniversalSymbol['kind'],
    signature: string,
  ): UniversalSymbol {
    return {
      id: `${modulePath}#${name}`,
      modulePath,
      name,
      kind,
      signature: signature.trim(),
    };
  }

  private extractExtensions(patterns: string[]): string[] {
    const exts: string[] = [];
    for (const p of patterns) {
      const match = p.match(/\.([a-zA-Z0-9_-]+)$/);
      if (match) {
        exts.push(`.${match[1]}`);
      }
    }
    return exts;
  }

  private matchesExtension(fileName: string, extensions: string[]): boolean {
    if (extensions.length === 0) return true;
    return extensions.some((ext) => fileName.endsWith(ext));
  }

  private isExcluded(relPath: string, excludePatterns: string[]): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    for (const pat of excludePatterns) {
      const clean = pat.replace(/^\*\*\//, '').replace(/\/\*\*$/, '').replace(/\*/g, '');
      if (clean && normalized.includes(clean)) {
        return true;
      }
    }
    return false;
  }
}
