/**
 * Autonomous Codebase Migration Runner (`src/runner/autonomousRunner.ts`).
 *
 * Loops through:
 *  1. claimNextLeaf() (Pass A: De-shim priority, Pass B: Transitive callee leaf)
 *  2. saveCheckpoint() (Automatic disk snapshot before edits)
 *  3. getMigrationSlice() (1-hop AST context, guidance, caller snippets)
 *  4. llmClient.generateTransform() (LLM code transformation)
 *  5. verifyAndCommitNode() (Tree-sitter AST, tsc --noEmit, route invariants, degrees)
 *  6. Use the checkpoint result from verify (tests and route diff), rolling back on failure
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FalkorClient } from '../engine/falkorClient';
import { MigrationGraphManager, getGraphNameForRepo } from '../engine/graphManager';
import { MigrationOps } from '../engine/operations';
import { LlmClient, type LlmClientOptions } from './llmClient';
import { saveCheckpoint, rollbackToCheckpoint } from './rollback';

export interface RunOptions extends LlmClientOptions {
  repoPath: string;
  packId?: string;
  graphName?: string;
  maxSteps?: number;
  autoRollbackOnFailure?: boolean;
  reset?: boolean;
  onProgress?: (progress: {
    step: number;
    phase: string;
    modules: string[];
    action: string;
    status: 'in_progress' | 'success' | 'warning' | 'error';
    details?: string;
  }) => void;
}

export interface AutonomousRunResult {
  ok: boolean;
  totalSteps: number;
  migratedModules: number;
  routeParity: boolean;
  checkpointPassed: boolean;
  durationMs: number;
  error?: string;
}

export async function runAutonomousMigration(options: RunOptions): Promise<AutonomousRunResult> {
  const startTime = Date.now();
  const repoPath = resolve(options.repoPath);
  const packId = options.packId ?? 'express-to-fastify';
  const graphName = options.graphName ?? getGraphNameForRepo(repoPath);
  const maxSteps = options.maxSteps ?? 50;
  const autoRollback = options.autoRollbackOnFailure ?? true;

  const client = await FalkorClient.connect({ graphName });

  // Auto-initialize graph if requested or if not initialized yet
  const countRes = await client
    .roQuery<{ n: number }>('MATCH (m:Module) RETURN count(m) AS n')
    .catch(() => [{ n: 0 }]);
  if (options.reset || !countRes.length || Number(countRes[0]?.n) === 0) {
    options.onProgress?.({
      step: 0,
      phase: 'INIT',
      modules: [],
      action: `Initializing migration graph for "${repoPath}"...`,
      status: 'in_progress',
    });
    await MigrationGraphManager.initMigrationGraph({
      repoPath,
      packId,
      graphName,
      client,
      reset: true,
    });
  }

  const mgr = await MigrationGraphManager.create(repoPath, packId, { graphName, client });
  const ops = new MigrationOps(mgr.db, mgr.pack, mgr.repoPath);
  const llm = new LlmClient({ ...options, language: options.language ?? mgr.pack.language });

  let stepCount = 0;
  const migratedSet = new Set<string>();

  try {
    while (stepCount < maxSteps) {
      stepCount++;

      // 1. Claim next leaf / circular SCC
      const claim = await ops.claimNextLeaf();
      if (!claim) {
        // No unblocked modules remaining -> Migration Complete!
        options.onProgress?.({
          step: stepCount,
          phase: 'DONE',
          modules: [],
          action: 'Complete',
          status: 'success',
          details: 'All modules have reached verified status!',
        });
        break;
      }

      options.onProgress?.({
        step: stepCount,
        phase: claim.phase,
        modules: claim.targetPaths,
        action: `Claimed ${claim.targetPaths.join(', ')} (${claim.phase})`,
        status: 'in_progress',
        details: claim.proof,
      });

      // 2. Save disk checkpoint before mutating files
      saveCheckpoint(repoPath, stepCount, claim.targetPaths);

      // 3. Obtain 1-hop migration slice
      const slice = await ops.getMigrationSlice(claim.targetPaths, claim.phase);

      // 4. Generate transform and write to disk
      let lastSummary = `Step ${stepCount} automated migration`;
      for (const targetMod of slice.targetModules) {
        options.onProgress?.({
          step: stepCount,
          phase: claim.phase,
          modules: [targetMod.path],
          action: `Generating code transform for ${targetMod.path}...`,
          status: 'in_progress',
        });

        const resp = await llm.generateTransform({
          targetPath: targetMod.path,
          phase: claim.phase,
          fullSource: targetMod.fullSource,
          guidance: slice.guidance,
          calleeSignatures: slice.calleeSignatures,
          callerSnippets: slice.callerSnippets,
        });

        writeFileSync(resolve(repoPath, targetMod.path), resp.code, 'utf8');
        lastSummary = resp.summary;
      }

      // 5. Gate check and commit node in FalkorDB
      options.onProgress?.({
        step: stepCount,
        phase: claim.phase,
        modules: claim.targetPaths,
        action: `Verifying AST, invariants & tsc for ${claim.targetPaths.join(', ')}...`,
        status: 'in_progress',
      });

      let verifyRes = await ops.verifyAndCommitNode(claim.targetPaths, lastSummary);

      // Self-healing attempt if verification failed
      if (!verifyRes.ok && verifyRes.errors.length) {
        options.onProgress?.({
          step: stepCount,
          phase: claim.phase,
          modules: claim.targetPaths,
          action: `Self-healing: fixing compilation/invariant errors...`,
          status: 'warning',
          details: verifyRes.errors.join('\n'),
        });

        for (const targetMod of slice.targetModules) {
          const healedResp = await llm.generateTransform({
            targetPath: targetMod.path,
            phase: claim.phase,
            fullSource: targetMod.fullSource,
            guidance: slice.guidance,
            calleeSignatures: slice.calleeSignatures,
            callerSnippets: slice.callerSnippets,
            previousErrors: verifyRes.errors,
          });
          writeFileSync(resolve(repoPath, targetMod.path), healedResp.code, 'utf8');
        }

        verifyRes = await ops.verifyAndCommitNode(claim.targetPaths, `${lastSummary} (self-healed)`);
      }

      if (!verifyRes.ok) {
        if (autoRollback) {
          await rollbackToCheckpoint(repoPath, packId, stepCount, graphName);
        }
        return {
          ok: false,
          totalSteps: stepCount,
          migratedModules: migratedSet.size,
          routeParity: false,
          checkpointPassed: false,
          durationMs: Date.now() - startTime,
          error: `Verification failed at step ${stepCount} on [${claim.targetPaths.join(', ')}]:\n${verifyRes.errors.join('\n')}`,
        };
      }

      claim.targetPaths.forEach((p) => migratedSet.add(p));

      // 6. Checkpoint gate already ran inside verify. Do not run it again.
      if (verifyRes.checkpointTriggered && verifyRes.checkpointResult) {
        const cp = verifyRes.checkpointResult;
        options.onProgress?.({
          step: stepCount,
          phase: claim.phase,
          modules: claim.targetPaths,
          action: `Checkpoint gate ${cp.tscPass && cp.testPass && cp.routeMatch ? 'passed' : 'failed'}`,
          status: cp.tscPass && cp.testPass && cp.routeMatch ? 'success' : 'error',
        });
        if (!cp.tscPass || !cp.testPass || !cp.routeMatch) {
          if (autoRollback) {
            await rollbackToCheckpoint(repoPath, packId, stepCount, graphName);
          }
          return {
            ok: false,
            totalSteps: stepCount,
            migratedModules: migratedSet.size,
            routeParity: cp.routeMatch,
            checkpointPassed: false,
            durationMs: Date.now() - startTime,
            error: `Checkpoint gate failed at step ${stepCount}: tests or route invariant mismatch.`,
          };
        }
      }

      options.onProgress?.({
        step: stepCount,
        phase: claim.phase,
        modules: claim.targetPaths,
        action: `Committed node state: ${verifyRes.newStatus}`,
        status: 'success',
      });
    }

    // Final audit check
    const finalTrail = await ops.getAuditTrail(true);
    const checkpointOk = finalTrail.checkpoint
      ? finalTrail.checkpoint.tscPass && finalTrail.checkpoint.testPass && finalTrail.checkpoint.routeMatch
      : true;
    const routeOk = finalTrail.checkpoint ? finalTrail.checkpoint.routeMatch : true;

    return {
      ok: true,
      totalSteps: stepCount,
      migratedModules: migratedSet.size,
      routeParity: routeOk,
      checkpointPassed: checkpointOk,
      durationMs: Date.now() - startTime,
    };
  } finally {
    await client.close();
  }
}
