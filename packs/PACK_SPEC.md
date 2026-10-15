# Migration Pack Specification (Layer 3)

A **Migration Pack** is a declarative (or programmatic) specification defining how to migrate a codebase from a legacy framework/library to a target framework/library using the **Shift** graph-governed migration engine.

---

## 1. Schema Overview

Packs can be authored as `.json` files or type-safe TypeScript/JavaScript modules using `defineMigrationPack(...)`.

```typescript
interface MigrationPack {
  $schema?: string;
  id: string;                      // Unique pack identifier (e.g. "express-to-fastify")
  name: string;                    // Human-readable title
  language: string;                // Language adapter key (e.g. "typescript", "python")
  sourceGlobs: {
    include: string[];             // Glob patterns to include (e.g. ["src/**/*.ts"])
    exclude?: string[];            // Glob patterns to exclude (e.g. ["**/dist/**"])
  };
  packages: {
    legacy: string[];              // Legacy package names (e.g. ["express"])
    target: string[];              // Target package names (e.g. ["fastify"])
  };
  detectionRules: DetectionRule[]; // AST query rules
  agentGuidance: Record<string, string>; // Migration phase instructions
  invariants: InvariantRule[];     // Behavioral invariant rules
  verification: {
    perStepTypecheckCmd: string;   // Command executed on every step (e.g. "npx tsc --noEmit")
    checkpointTestCmd: string;     // Command executed at checkpoints (e.g. "npm test")
    routeSnapshotCmd: string;      // Command dumping runtime route inventory
  };
}
```

---

## 2. Detection Rules (`detectionRules`)

Detection rules use Tree-sitter AST queries (S-expressions) to locate framework-specific APIs and methods in source files:

```json
{
  "id": "express-res-methods",
  "description": "Express response methods (.status, .json, .send)",
  "astQuery": "(call_expression (member_expression property: (property_identifier) @prop) (#match? @prop \"^(status|json|send|sendStatus)$\"))"
}
```

When evaluated, matches are stored in FalkorDB as `(:ExternalAPI)` nodes with `[:USES_API]` edges from declaring modules.

---

## 3. Dual-Signature Shim & De-Shim Workflow

The Strangler Fig pattern is enforced through three phases:

1. **`SHIM` (Backward Compatibility):**
   - Triggered when `pending_callers_count > 0`.
   - Modifies the callee to support both new callers (target signatures) and legacy callers (old signatures).
   - All legacy fallback lines must be annotated with `// @shift-shim`.
2. **`MIGRATE` (Internal Migration):**
   - Triggered when a module has no unmigrated dependencies.
   - Converts internal module routing and handlers to target framework patterns.
3. **`DE_SHIM` (Pure Modernization):**
   - Triggered when `pending_callers_count === 0` on a previously shimmed module.
   - Strips all legacy wrappers and fallback branches (`// @shift-shim`).

---

## 4. Verification Gates (`verification`)

- **Per-Step Typechecking:** Executed after every file modification. If typechecking fails, the transaction is rejected and the graph state is rolled back.
- **Checkpoint Gates:** Triggered when an SCC or de-shim milestone is reached. Executes test suites and performs strict set-equality comparisons on route snapshots against the baseline captured during `init_migration_graph`.

---

## 5. Pack CLI Tools

```bash
# Scaffold a new migration pack
shift pack init <pack-id> --lang <language>

# Validate pack structure and detection rules
shift pack validate <path-to-pack>
```
