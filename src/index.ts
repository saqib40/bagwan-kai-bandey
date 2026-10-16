/**
 * Bagwan Kai Bandey (BKB) — Graph-Governed Codebase Migration Engine.
 * Public SDK & Extensibility Entrypoint (`src/index.ts`).
 */

// Layer 1: Core Engine
export { MigrationGraphManager, type InitGraphOptions, type GraphSummary } from './engine/graphManager';
export {
  MigrationOps,
  type Phase,
  type ClaimResult,
  type MigrationSlice,
  type BlastRadiusEntry,
  type VerifyResult,
} from './engine/operations';
export { FalkorClient, type Params } from './engine/falkorClient';
export { tarjanScc, type SccResult } from './engine/scc';
export { ensureFalkorDB } from './engine/docker';

// Layer 1: Configuration & Migration Pack Loader
export {
  defineMigrationPack,
  validatePack,
  loadPack,
  loadPackAsync,
} from './engine/packLoader';
export { validatePackSchema } from './engine/packSchema';
export {
  RUNTIME_INTEROP_MIN_NODE,
  parseNodeVersion,
  compareVersions,
  isRuntimeInteropSupported,
  checkRuntimePreflight,
  assertRuntimeInteropSupport,
  type RuntimePreflightResult,
} from './engine/runtimePreflight';
export {
  validatePackSemantics,
  validatePackQueries,
  type SemanticValidationResult,
  type QueryValidationResult,
} from './engine/packSemantics';
export {
  evaluatePackageDetectors,
  formatPackageDetectorAdvisories,
  type PackageDetectorResult,
} from './engine/packageDetectors';
export {
  defineConfig,
  loadConfig,
  type BkbConfig,
  type ShiftConfig,
} from './engine/config';

// Layer 2: Language & AST Adapters
export {
  type LanguageAdapter,
  type ParsedModule,
  type UniversalSymbol,
  type APIUsage,
  type DetectionRule,
  type InvariantRule,
  type VerificationSnapshot,
  type SnapshotKind,
  type PackageDetector,
  type MigrationPack,
  type ShimStrategy,
} from './adapters/types';
export { getShimStrategy, DEFAULT_SHIM_STRATEGY, RUNTIME_INTEROP_MARKER } from './adapters/types';
export { BaseLanguageAdapter } from './adapters/baseAdapter';
export { TreeSitterQueryAdapter } from './adapters/treeSitterAdapter';
export { TypeScriptAdapter } from './adapters/typescriptAdapter';
export { PythonAdapter } from './adapters/pythonAdapter';
export { adapterRegistry, AdapterRegistry } from './adapters/registry';

// Layer 3: MCP Server
export {
  startMcpServer,
  createBkbMcpServer,
  createShiftMcpServer,
  type BkbServerOptions,
  type ShiftServerOptions,
} from './mcp/server';

// Layer 4: Autonomous Terminal Runner & Rollback
export {
  runAutonomousMigration,
  type RunOptions,
  type AutonomousRunResult,
} from './runner/autonomousRunner';
export {
  LlmClient,
  type LlmClientOptions,
  type LlmRequest,
  type LlmResponse,
  extractCodeFromMarkdown,
  loadFixtureMockTransforms,
  shimRuleForStrategy,
} from './runner/llmClient';
export {
  saveCheckpoint,
  listCheckpoints,
  rollbackToCheckpoint,
  clearCheckpoints,
  getCheckpointsDir,
  type CheckpointInfo,
} from './runner/rollback';
