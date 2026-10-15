/**
 * Layer 1 — FalkorDB connection wrapper.
 * HARD RULE: this directory must stay framework/language agnostic.
 */
import { FalkorDB } from 'falkordb';
import type Graph from 'falkordb/dist/src/graph';

export type Params = Record<string, unknown>;

export class FalkorClient {
  private constructor(
    private readonly db: FalkorDB,
    private readonly graph: Graph,
    readonly graphName: string,
  ) {}

  static async connect(opts: { url?: string; graphName?: string } = {}): Promise<FalkorClient> {
    const url = opts.url ?? process.env.FALKORDB_URL ?? 'falkor://127.0.0.1:6379';
    const graphName = opts.graphName ?? process.env.BKB_GRAPH ?? process.env.SHIFT_GRAPH ?? 'bkb';
    const db = await FalkorDB.connect({ url });
    db.on('error', (err: unknown) => console.error('[bkb] falkordb error:', err));
    return new FalkorClient(db, db.selectGraph(graphName), graphName);
  }

  /** Read/write query returning rows as plain objects. */
  async query<T = Record<string, any>>(cypher: string, params?: Params): Promise<T[]> {
    const res = await this.graph.query<T>(cypher, params ? { params: params as any } : undefined);
    return (res.data ?? []) as T[];
  }

  /** Read-only query. */
  async roQuery<T = Record<string, any>>(cypher: string, params?: Params): Promise<T[]> {
    const res = await this.graph.roQuery<T>(cypher, params ? { params: params as any } : undefined);
    return (res.data ?? []) as T[];
  }

  /** Drops the whole graph (ignores "graph does not exist"). */
  async reset(): Promise<void> {
    try {
      await this.graph.delete();
    } catch (err) {
      if (!String(err).toLowerCase().includes('empty key')) throw err;
    }
  }

  /** Creates an index, ignoring "already indexed" errors. */
  async ensureIndex(cypher: string): Promise<void> {
    try {
      await this.graph.query(cypher);
    } catch (err) {
      if (!/already indexed|already exists/i.test(String(err))) throw err;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
