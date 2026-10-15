/**
 * Milestone 0: standalone validation of every Tree-sitter query in the pack
 * against demo-repo (baseline) and the scratch shim/final snapshots.
 *
 * Usage: tsx scripts/validate-queries.ts [extraRepoDir...]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language, Query, type QueryCapture } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const pack = JSON.parse(readFileSync(new URL('../packs/express-to-fastify.json', import.meta.url), 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

await Parser.init();
const lang = await Language.load(require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'));
const parser = new Parser();
parser.setLanguage(lang);

const rules = pack.detectionRules.map((r: any) => ({ id: r.id, query: new Query(lang, r.astQuery) }));
const routeQuery = new Query(lang, pack.invariants[0].astExtractor);

let failures = 0;
const expect = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error(`  ✖ ${msg}`);
  }
};

const repos = [join(import.meta.dirname, '../demo-repo'), ...process.argv.slice(2)];
for (const repo of repos) {
  console.log(`\n=== ${repo}`);
  for (const file of walk(join(repo, 'src')).sort()) {
    const rel = relative(repo, file);
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const tree = parser.parse(src)!;
    const hits: string[] = [];
    for (const rule of rules) {
      for (const m of rule.query.matches(tree.rootNode)) {
        const row = Math.min(...m.captures.map((c: QueryCapture) => c.node.startPosition.row));
        const shim = lines[row].includes('// @shift-shim');
        hits.push(`${rule.id}@L${row + 1}${shim ? '[shim]' : ''}`);
      }
    }
    const routes = new Set(
      routeQuery.matches(tree.rootNode).map((m) => {
        const cap = (n: string) => m.captures.find((c) => c.name === n)!.node.text;
        return `${cap('method').toUpperCase()} ${cap('path')}`;
      }),
    );
    console.log(`${rel.padEnd(28)} hasError=${tree.rootNode.hasError} legacy=${hits.length} [${hits.join(', ')}]`);
    console.log(`${''.padEnd(28)} routes=${JSON.stringify([...routes].sort())}`);

    expect(!tree.rootNode.hasError, `${rel}: syntax ERROR nodes`);
    if (rel.endsWith('middleware/auth.ts')) expect(routes.size === 0, `${rel}: req.get misclassified as route`);
    if (rel.endsWith('routes/users.ts'))
      expect(JSON.stringify([...routes].sort()) === '["GET /","GET /:id","POST /"]', `${rel}: route set`);
    if (rel.endsWith('routes/orders.ts'))
      expect(JSON.stringify([...routes].sort()) === '["GET /","GET /:id"]', `${rel}: route set`);
    if (repo === repos[0]) {
      const clean = rel.endsWith('hash.ts') || rel.endsWith('server.ts');
      expect(clean ? hits.length === 0 : hits.length > 0, `${rel}: expected ${clean ? 'CLEAN' : 'PENDING'}`);
    }
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL QUERY CHECKS PASSED');
process.exit(failures ? 1 : 0);
