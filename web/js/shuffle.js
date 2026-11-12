// Shuffle: a random problem from the set the explorer's filters leave, the same set the
// problem page's previous/next arrows walk. Plain random, never the one already open.

/** @returns a problem from `list` other than `currentSlug`, or null when there is none. */
export function randomProblem(list, currentSlug = null, rand = Math.random) {
  const pool = currentSlug ? list.filter(problem => problem.slug !== currentSlug) : list;
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

/** Single-flight orchestration. Dependencies are explicit so tests never use the network. */
export function createLeetCodeShuffle({ random, importProblem, onOpen, onBusy = () => {} }) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run() {
      if (busy) return;
      busy = true;
      onBusy(true);
      try {
        const result = await random();
        if (!result?.ok) throw Error(result?.message || 'The Connector could not find a problem.');
        if (typeof result.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.slug)
          || result.paidOnly !== false) throw Error('The Connector returned an invalid or premium random problem. Shuffle again.');
        const saved = await importProblem({ slug: result.slug, source: 'others' });
        await onOpen(saved);
      } finally {
        busy = false;
        onBusy(false);
      }
    },
  };
}
