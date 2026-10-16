/**
 * Bagwan Kai Bandey (BKB) Live Telemetry & Event Bus (`src/engine/telemetry.ts`).
 *
 * Provides real-time synchronization between CLI commands, MCP server actions,
 * and the browser Migration Cockpit (`localhost:4200`) via low-latency HTTP broadcasts.
 */

export type LiveEventType =
  | 'init'
  | 'claim'
  | 'verify'
  | 'failure'
  | 'rollback'
  | 'complete';

export interface LiveEvent {
  type: LiveEventType;
  repoPath: string;
  packId?: string;
  targetPaths?: string[];
  phase?: 'MIGRATE' | 'SHIM' | 'DE_SHIM';
  status?: string;
  step?: number;
  totalSteps?: number;
  agentSummary?: string;
  errors?: string[];
  timestamp?: number;
}

/**
 * Broadcasts an event to the local BKB Cockpit server (if running).
 * Designed to be completely non-blocking (fire-and-forget, 300ms timeout),
 * ensuring CLI and MCP server operations never lag even if the browser server is offline.
 */
export function broadcastLiveEvent(event: LiveEvent): void {
  const port = Number(process.env.BKB_COCKPIT_PORT ?? process.env.PORT ?? 4200);
  const payload = JSON.stringify({ ...event, timestamp: event.timestamp ?? Date.now() });

  try {
    // Native fetch with fast AbortSignal timeout
    fetch(`http://127.0.0.1:${port}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(300),
    }).catch(() => {
      // Cockpit server is not running on port 4200; gracefully ignore
    });
  } catch {
    // Ignore runtime or network environment errors
  }
}
