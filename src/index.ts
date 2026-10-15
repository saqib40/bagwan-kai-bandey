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
  type MigrationPack,
} from './adapters/types';
export { BaseLanguageAdapter } from './adapters/baseAdapter';
export { TypeScriptAdapter } from './adapters/typescriptAdapter';
export { adapterRegistry, AdapterRegistry } from './adapters/registry';

// Layer 3: MCP Server
export {
  startMcpServer,
  createBkbMcpServer,
  createShiftMcpServer,
  type BkbServerOptions,
  type ShiftServerOptions,
} from './mcp/server';
