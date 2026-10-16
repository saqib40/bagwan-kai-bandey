/**
 * Layer 2 — Shared Tree-Sitter Query Adapter (`src/adapters/treeSitterAdapter.ts`).
 *
 * Owns the language-neutral Tree-sitter plumbing shared by all tree-sitter backed
 * language adapters (TypeScript, Python, ...):
 *  - parser/grammar lifecycle
 *  - compiled query caching
 *  - detection-rule evaluation (`apiUsages`)
 *  - invariant extraction (`invariantSets`)
 *  - syntax-error collection and shim-line counting
 *
 * Subclasses supply only the grammar, symbol extraction, and import resolution.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser, Language, Query, type Node as TSNode } from 'web-tree-sitter';
import {
  lineHasShimMarker,
  type ParsedModule,
  type UniversalSymbol,
  type APIUsage,
  type DetectionRule,
  type InvariantRule,
  type MigrationPack,
} from './types';
import { BaseLanguageAdapter } from './baseAdapter';

export abstract class TreeSitterQueryAdapter extends BaseLanguageAdapter {
  protected parser: Parser | null = null;
  private queryCache = new Map<string, Query>();

  /** Returns the tree-sitter grammar to use for a given relative file path. */
  protected abstract getLanguageForPath(path: string): Language;

  /** Resolves internal module imports from a parsed tree. */
  protected abstract extractInternalImports(root: TSNode, repoRoot: string, currentFile: string): string[];

  /** Extracts exported/universal symbols from a parsed tree. */
  protected abstract extractExportedSymbols(root: TSNode, modulePath: string): UniversalSymbol[];

  protected getCompiledQuery(lang: Language, queryString: string): Query {
    const key = `${lang.version}:${queryString}`;
    let q = this.queryCache.get(key);
    if (!q) {
      q = new Query(lang, queryString);
      this.queryCache.set(key, q);
    }
    return q;
  }

  protected collectSyntaxErrors(root: TSNode): string[] {
    const syntaxErrors: string[] = [];
    const findErrors = (node: TSNode) => {
      if (node.type === 'ERROR' || node.isMissing) {
        syntaxErrors.push(
          `Syntax error at line ${node.startPosition.row + 1}, col ${node.startPosition.column}: "${node.text}"`,
        );
      }
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) findErrors(c);
      }
    };
    findErrors(root);
    return syntaxErrors;
  }

  protected evaluateDetectionRules(
    lang: Language,
    root: TSNode,
    lines: string[],
    rules: DetectionRule[],
  ): APIUsage[] {
    const apiUsages: APIUsage[] = [];
    for (const rule of rules) {
      try {
        const query = this.getCompiledQuery(lang, rule.astQuery);
        const matches = query.matches(root);
        const seenLines = new Set<number>();
        for (const match of matches) {
          const startRow = Math.min(...match.captures.map((c) => c.node.startPosition.row));
          const line = startRow + 1;
          if (seenLines.has(line)) continue;
          seenLines.add(line);

          const snippet = lines[startRow]?.trim() ?? '';
          const lineContent = lines[startRow] ?? '';
          const isShimmed = lineHasShimMarker(lineContent);

          apiUsages.push({ ruleId: rule.id, line, snippet, isShimmed });
        }
      } catch (err) {
        console.error(`[${this.constructor.name}] Error evaluating rule "${rule.id}":`, err);
      }
    }
    return apiUsages;
  }

  protected evaluateInvariants(
    lang: Language,
    root: TSNode,
    invariants: InvariantRule[],
  ): Record<string, string[]> {
    const invariantSets: Record<string, string[]> = {};
    for (const inv of invariants) {
      try {
        const query = this.getCompiledQuery(lang, inv.astExtractor);
        const matches = query.matches(root);
        const extracted = new Set<string>();

        for (const match of matches) {
          const capMap = new Map<string, string>();
          for (const c of match.captures) {
            capMap.set(c.name, c.node.text);
          }

          if (inv.format) {
            const formatted = inv.format.replace(/\{(\w+)(?:\|(\w+))?\}/g, (_, name, transform) => {
              let val = capMap.get(name) ?? '';
              if (transform === 'upper') val = val.toUpperCase();
              if (transform === 'lower') val = val.toLowerCase();
              return val;
            });
            extracted.add(formatted);
          } else {
            const method = capMap.get('method')?.toUpperCase();
            const pathVal = capMap.get('path');
            if (method && pathVal) {
              extracted.add(`${method} ${pathVal}`);
            }
          }
        }
        invariantSets[inv.id] = [...extracted].sort();
      } catch (err) {
        console.error(`[${this.constructor.name}] Error evaluating invariant "${inv.id}":`, err);
      }
    }
    return invariantSets;
  }

  async parseModule(
    repoRoot: string,
    relativePath: string,
    sourceCode?: string,
    pack?: MigrationPack,
  ): Promise<ParsedModule> {
    await this.init();
    if (!this.parser) {
      throw new Error(`${this.constructor.name} not initialized. Call init() first.`);
    }

    const normalizedRelPath = relativePath.split('\\').join('/');
    const fullDiskPath = resolve(repoRoot, normalizedRelPath);
    const content = sourceCode ?? readFileSync(fullDiskPath, 'utf8');
    const lines = content.split('\n');

    const lang = this.getLanguageForPath(normalizedRelPath);
    this.parser.setLanguage(lang);
    const tree = this.parser.parse(content)!;
    const root = tree.rootNode;

    const syntaxErrors = root.hasError ? this.collectSyntaxErrors(root) : [];
    const imports = this.extractInternalImports(root, repoRoot, normalizedRelPath);
    const symbols = this.extractExportedSymbols(root, normalizedRelPath);
    const apiUsages = this.evaluateDetectionRules(lang, root, lines, pack?.detectionRules ?? []);
    const invariantSets = this.evaluateInvariants(lang, root, pack?.invariants ?? []);
    const shimLineCount = lines.filter((l) => lineHasShimMarker(l)).length;

    return {
      path: normalizedRelPath,
      fullSource: content,
      imports,
      symbols,
      apiUsages,
      invariantSets,
      shimLineCount,
      hasSyntaxError: root.hasError || syntaxErrors.length > 0,
      syntaxErrors,
    };
  }
}
