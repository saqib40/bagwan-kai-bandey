/**
 * Layer 1 — Docker Container Lifecycle Bootstrapper.
 * Manages the FalkorDB container lifecycle according to plan §9.
 * Stdio discipline: all messages are sent to console.error().
 * Hard Rule: Zero mentions of framework or language specifics.
 */

import { execSync } from 'node:child_process';
import net from 'node:net';
import { FalkorClient } from './falkorClient';

const CONTAINER_NAME = 'falkordb-shift-engine';
const DEFAULT_URL = 'falkor://127.0.0.1:6379';

export interface BootstrapperOptions {
  url?: string;
  skipDocker?: boolean;
}

export async function checkPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false); // port is occupied
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true); // port is free
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.connect(port, host);
  });
}

export async function waitForPing(url: string, maxAttempts = 30, intervalMs = 500): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const client = await FalkorClient.connect({ url, graphName: 'shift_ping' });
      await client.query('RETURN 1');
      await client.close();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

export async function ensureFalkorDB(opts: BootstrapperOptions = {}): Promise<string> {
  const url = opts.url ?? process.env.FALKORDB_URL ?? DEFAULT_URL;

  // 1. If explicit URL set in env or options, test connection directly
  if (process.env.FALKORDB_URL || opts.url || opts.skipDocker) {
    console.error(`[shift] Connecting to configured FalkorDB at ${url}...`);
    const ok = await waitForPing(url, 10, 500);
    if (!ok) {
      throw new Error(`Cannot connect to FalkorDB at ${url}. Please verify server is running.`);
    }
    console.error(`[shift] Connected to FalkorDB at ${url}`);
    return url;
  }

  // 2. Check if already responding at default url
  const quickCheck = await waitForPing(url, 2, 200);
  if (quickCheck) {
    console.error(`[shift] FalkorDB already running and responding at ${url}`);
    return url;
  }

  // 3. Inspect docker container
  console.error(`[shift] Inspecting Docker container "${CONTAINER_NAME}"...`);
  let status = '';
  try {
    status = execSync(
      `docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format "{{.Status}}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (err) {
    throw new Error(
      `Docker is not available or not running. Please start Docker or supply FALKORDB_URL.\n${String(err)}`,
    );
  }

  if (status.startsWith('Up')) {
    console.error(`[shift] Container "${CONTAINER_NAME}" is running: ${status}`);
  } else if (status.length > 0) {
    console.error(`[shift] Starting stopped container "${CONTAINER_NAME}"...`);
    execSync(`docker start ${CONTAINER_NAME}`, { stdio: ['ignore', 'ignore', 'inherit'] });
  } else {
    // Check ports 6379 and 3000
    const port6379Free = await checkPortFree(6379);
    const port3000Free = await checkPortFree(3000);
    if (!port6379Free) {
      throw new Error('Port 6379 is already in use by another process. Free port 6379 or set FALKORDB_URL.');
    }
    if (!port3000Free) {
      console.error('[shift] Warning: Port 3000 (FalkorDB Browser) is in use. FalkorDB Browser might not be accessible.');
    }

    console.error(`[shift] Launching new FalkorDB container "${CONTAINER_NAME}"...`);
    const port3000Flag = port3000Free ? '-p 3000:3000' : '';
    execSync(
      `docker run -d --name ${CONTAINER_NAME} -p 6379:6379 ${port3000Flag} -v falkordb_shift_data:/data falkordb/falkordb:latest`,
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  }

  console.error(`[shift] Waiting for FalkorDB ping at ${url}...`);
  const ready = await waitForPing(url, 30, 500);
  if (!ready) {
    throw new Error(`FalkorDB container started but failed to respond to PING at ${url}.`);
  }

  console.error(`[shift] FalkorDB is ready at ${url}`);
  return url;
}
