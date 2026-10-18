/**
 * Interactive CLI Onboarding Wizard (`src/cli/wizard.ts`).
 * Guides developers step-by-step through setting up and running a migration.
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { discoverPackIds } from '../engine/packLoader';

export interface WizardOptions {
  repoPath: string;
  packId: string;
  reset: boolean;
  launchCockpit: boolean;
}

export async function runInteractiveInit(defaultRepo = './demo-repo'): Promise<WizardOptions> {
  const rl = readline.createInterface({ input, output });

  try {
    output.write('\n');
    output.write('  \x1b[1;36m┌────────────────────────────────────────────────────────┐\x1b[0m\n');
    output.write('  \x1b[1;36m│     Bagwan Kai Bandey (BKB) Migration Setup Wizard     │\x1b[0m\n');
    output.write('  \x1b[1;36m└────────────────────────────────────────────────────────┘\x1b[0m\n\n');

    // 1. Repo Path
    const repoAns = await rl.question(`  \x1b[1m1. Target repository to migrate\x1b[0m (default: \x1b[32m${defaultRepo}\x1b[0m): `);
    const chosenRepo = repoAns.trim() || defaultRepo;

    // 2. Discover available packs
    const packsDir = resolve(process.cwd(), 'packs');
    let availablePacks: string[] = ['express-to-fastify'];
    const found = discoverPackIds(packsDir);
    if (found.length) availablePacks = Array.from(new Set([...availablePacks, ...found]));

    output.write('\n  \x1b[1m2. Select Migration Pack:\x1b[0m\n');
    availablePacks.forEach((p, idx) => {
      output.write(`     [${idx + 1}] ${p}${idx === 0 ? ' (built-in recommendation)' : ''}\n`);
    });
    output.write(`     [${availablePacks.length + 1}] Enter custom pack path or identifier\n`);

    const packAns = await rl.question(`  Choose pack [1-${availablePacks.length + 1}] (default: 1): `);
    const packChoice = parseInt(packAns.trim() || '1', 10);

    let chosenPack = availablePacks[0] ?? 'express-to-fastify';
    if (packChoice >= 1 && packChoice <= availablePacks.length) {
      chosenPack = availablePacks[packChoice - 1]!;
    } else if (packChoice === availablePacks.length + 1) {
      const customPack = await rl.question('  Enter pack path or name: ');
      chosenPack = customPack.trim() || 'express-to-fastify';
    }

    // 3. Reset graph
    const resetAns = await rl.question('\n  \x1b[1m3. Reset FalkorDB graph before ingest?\x1b[0m (Y/n): ');
    const chosenReset = !resetAns.trim().toLowerCase().startsWith('n');

    // 4. Launch cockpit?
    const cockpitAns = await rl.question('\n  \x1b[1m4. Launch real-time visual cockpit (http://localhost:4200)?\x1b[0m (Y/n): ');
    const chosenCockpit = !cockpitAns.trim().toLowerCase().startsWith('n');

    output.write('\n');
    return {
      repoPath: chosenRepo,
      packId: chosenPack,
      reset: chosenReset,
      launchCockpit: chosenCockpit,
    };
  } finally {
    rl.close();
  }
}
