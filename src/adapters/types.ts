/**
 * Layer 2 — Language Adapter Types.
 * Language adapters translate source files into universal graph representations.
 */

export interface UniversalSymbol {
  /** Unique symbol ID: `{modulePath}#{symbolName}` */
  id: string;
  /** Relative path of declaring module */
  modulePath: string;
  /** Identifier name */
  name: string;
  /** Kind of symbol */
  kind: 'function' | 'class' | 'type' | 'variable';
  /** Exported signature (without function body) */
  signature: string;
}

export interface APIUsage {
  /** Detection rule ID from Migration Pack */
  ruleId: string;
  /** 1-indexed source line */
  line: number;
  /** Source code snippet / preview */
  snippet: string;
  /** True if the line contains `// @bkb-shim` or `// @shift-shim` */
  isShimmed: boolean;
}

export interface ParsedModule {
  /** Relative path to repo root (e.g., 'src/utils/response.ts') */
  path: string;
  /** Full source code content */
  fullSource: string;
  /** Resolved relative paths to other internal modules imported */
  imports: string[];
  /** Exported symbols declared in this module */
  symbols: UniversalSymbol[];
  /** Legacy/target API usages detected by pack queries */
  apiUsages: APIUsage[];
  /** Extracted AST invariant sets (e.g., route surface) */
  invariantSets: Record<string, string[]>;
  /** Count of lines containing `// @bkb-shim` or `// @shift-shim` */
  shimLineCount: number;
  /** Whether parser encountered syntax errors */
  hasSyntaxError: boolean;
  /** List of syntax error descriptions if any */
  syntaxErrors: string[];
}

export interface DetectionRule {
  id: string;
  description: string;
  astQuery: string;
}

export interface InvariantRule {
  id: string;
  scope: 'per-step' | 'checkpoint';
  type: string;
  description: string;
  astExtractor: string;
  format?: string;
}

export interface MigrationPack {
  $schema?: string;
  id: string;
  name: string;
  language: string;
  trustedExecutionNote?: string;
  knownLimitations?: string[];
  sourceGlobs: {
    include: string[];
    exclude?: string[];
  };
  packages: {
    legacy: string[];
    target: string[];
  };
  detectionRules: DetectionRule[];
  agentGuidance: Record<string, string>;
  invariants: InvariantRule[];
  verification: {
    perStepTypecheckCmd: string;
    checkpointTestCmd: string;
    routeSnapshotCmd: string;
  };
}

export interface LanguageAdapter {
  readonly language: string;
  init(): Promise<void>;
  parseModule(
    repoRoot: string,
    relativePath: string,
    sourceCode?: string,
    pack?: MigrationPack,
  ): Promise<ParsedModule>;
  findSourceFiles(
    repoRoot: string,
    sourceGlobs: { include: string[]; exclude?: string[] },
  ): Promise<string[]>;
}
