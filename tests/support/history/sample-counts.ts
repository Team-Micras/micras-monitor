import type { HistoryStore, VariableRef } from '@/history';

/**
 * How many samples of a variable the store can hand out now, counted through
 * {@link HistoryStore.samples}: every kept sample while its blocks are in memory.
 */
export function storedSamples(store: HistoryStore, variable: VariableRef): number {
  let count = 0;

  for (const run of store.samples(variable, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)) {
    count += run.time.length;
  }

  return count;
}

/** How many samples of a variable the source lost, from its gaps of dropped samples. */
export function droppedSamples(store: HistoryStore, variable: VariableRef): number {
  return store
    .gaps(variable, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
    .filter((gap) => gap.kind === 'dropped')
    .reduce((sum, gap) => sum + (gap.count ?? 0), 0);
}

/** How many runs hand out samples of a variable now, counted through {@link HistoryStore.samples}. */
export function runsWithSamples(store: HistoryStore, variable: VariableRef): number {
  const runs = new Set<number>();

  for (const run of store.samples(variable, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)) {
    runs.add(run.runId);
  }

  return runs.size;
}
