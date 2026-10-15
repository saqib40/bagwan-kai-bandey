/**
 * Layer 1 — Tarjan's Strongly Connected Components (iterative, no recursion limits).
 * Input: adjacency list keyed by node id. Output: deterministic SCC ids
 * (sorted by smallest member id) plus SCC sizes.
 */
export interface SccResult {
  /** node -> scc id */
  sccOf: Map<string, number>;
  /** scc id -> members (sorted) */
  members: Map<number, string[]>;
}

export function tarjanScc(adjacency: Map<string, string[]>): SccResult {
  // Ensure every referenced node exists as a key.
  const graph = new Map<string, string[]>();
  for (const [from, tos] of adjacency) {
    graph.set(from, [...new Set(tos)].sort());
    for (const to of tos) if (!adjacency.has(to)) graph.set(to, graph.get(to) ?? []);
  }

  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const root of [...graph.keys()].sort()) {
    if (idx.has(root)) continue;
    // Explicit DFS stack of [node, nextNeighbourIndex].
    const work: Array<[string, number]> = [[root, 0]];
    idx.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);

    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const neighbours = graph.get(v)!;
      if (i < neighbours.length) {
        frame[1]++;
        const w = neighbours[i];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
        continue;
      }
      // All neighbours processed.
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        components.push(comp.sort());
      }
    }
  }

  components.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sccOf = new Map<string, number>();
  const members = new Map<number, string[]>();
  components.forEach((comp, id) => {
    members.set(id, comp);
    for (const n of comp) sccOf.set(n, id);
  });
  return { sccOf, members };
}
