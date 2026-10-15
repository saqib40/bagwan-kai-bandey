# Extensibility: Custom Packs & Language Adapters

> Learn how to extend **Bagwan Kai Bandey (BKB)** to migrate new frameworks, libraries, and programming languages without modifying engine internals.

---

## 1. Overview

Bagwan Kai Bandey separates the migration engine into three layers:
- **Universal Engine (Layer 1)**: Graph logic, topological scheduler, MCP server.
- **Language Adapters (Layer 2)**: AST parsing, symbol extraction, import graph extraction.
- **Migration Packs (Layer 3)**: Framework detection rules, shim guidance, verification commands.

You can author and inject custom Language Adapters and Migration Packs to support any stack (e.g., Flask $\rightarrow$ FastAPI in Python, React Router 5 $\rightarrow$ 6, Jest $\rightarrow$ Vitest, or proprietary internal frameworks).

---

## 2. Authoring a Custom Language Adapter (Layer 2)

Extend the built-in `BaseLanguageAdapter` to get automatic file discovery, source caching, shim counters, and symbol ID generation:

```typescript
// adapters/pythonAdapter.ts
import {
  BaseLanguageAdapter,
  type ParsedModule,
  type MigrationPack,
} from 'bagwan-kai-bandey';

export class PythonAdapter extends BaseLanguageAdapter {
  readonly language = 'python';

  async parseModule(
    repoRoot: string,
    relativePath: string,
    sourceCode?: string,
    pack?: MigrationPack,
  ): Promise<ParsedModule> {
    const code = sourceCode ?? (await this.readSource(repoRoot, relativePath));

    // Custom import extraction logic (e.g. Tree-sitter or regex)
    const imports = this.extractPythonImports(code);

    // Custom function/class signature extraction
    const symbols = this.extractPythonSymbols(code, relativePath);

    return this.createParsedModule({
      path: relativePath,
      fullSource: code,
      imports,
      symbols,
    });
  }

  private extractPythonImports(code: string): string[] {
    const imports: string[] = [];
    const lines = code.split('\n');
    for (const line of lines) {
      const match = line.match(/^from\s+([a-zA-Z0-9_.]+)\s+import/);
      if (match) imports.push(match[1]);
    }
    return imports;
  }

  private extractPythonSymbols(code: string, relativePath: string) {
    const symbols = [];
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (match) {
        symbols.push({
          id: this.createSymbolId(relativePath, match[1]),
          name: match[1],
          kind: 'function' as const,
          signature: `def ${match[1]}(${match[2]})`,
          line: i + 1,
        });
      }
    }
    return symbols;
  }
}

export default PythonAdapter;
```

### Scaffolding an Adapter via CLI
```bash
# Generate a starter adapter skeleton:
bkb adapter init python
```

---

## 3. Authoring a Custom Migration Pack (Layer 3)

Packs define the transformation rules, AST queries, and verification commands. You can write packs as standard `.json` files or type-safe TypeScript files using `defineMigrationPack`:

```typescript
// packs/flask-to-fastapi.ts
import { defineMigrationPack } from 'bagwan-kai-bandey';

export default defineMigrationPack({
  id: 'flask-to-fastapi',
  name: 'Flask to FastAPI Migration Pack',
  language: 'python',
  sourceGlobs: {
    include: ['**/*.py'],
    exclude: ['**/venv/**', '**/__pycache__/**', '**/test/**'],
  },
  packages: {
    legacy: ['flask'],
    target: ['fastapi', 'uvicorn'],
  },
  detectionRules: [
    {
      id: 'flask-route-decorator',
      description: 'Matches @app.route decorator definitions',
      astQuery: '(decorator (call (attribute (identifier) @obj (identifier) @method)))',
    },
  ],
  agentGuidance: {
    SHIM: 'Wrap Flask Request/Response in FastAPI compatibility shims using // @bkb-shim.',
    MIGRATE: 'Convert Flask route handlers to async def with FastAPI APIRouter and Pydantic models.',
    DE_SHIM: 'Remove all Flask compatibility wrappers and legacy fallback branches.',
  },
  invariants: [
    {
      id: 'http-endpoints',
      scope: 'checkpoint',
      type: 'route-set',
      description: 'Guarantees 100% endpoint parity before and after migration',
      astExtractor: 'routes',
    },
  ],
  verification: {
    perStepTypecheckCmd: 'mypy src/',
    checkpointTestCmd: 'pytest test/',
    routeSnapshotCmd: 'python scripts/dump_routes.py',
  },
});
```

### Scaffolding and Validating Packs via CLI
```bash
# 1. Scaffold a new pack skeleton:
bkb pack init flask-to-fastapi --lang python

# 2. Validate a pack schema before running:
bkb pack validate ./packs/flask-to-fastapi.json
```

---

## 4. Unified Project Configuration (`bkb.config.ts`)

Instead of specifying CLI flags repeatedly, you can configure your repository with a `bkb.config.ts` (or `bkb.config.js`) file in the repository root:

```typescript
// bkb.config.ts
import { defineConfig } from 'bagwan-kai-bandey';
import { PythonAdapter } from './adapters/pythonAdapter';

export default defineConfig({
  adapters: [new PythonAdapter()],
  packDirs: ['./custom-packs', './node_modules/@company/migration-packs'],
  defaultRepo: './my-app',
  defaultPack: 'flask-to-fastapi',
  graphName: 'my_app_migration',
});
```

When present, `bkb init`, `bkb run`, and `bkb serve` will automatically resolve configuration values without requiring explicit CLI flags.
