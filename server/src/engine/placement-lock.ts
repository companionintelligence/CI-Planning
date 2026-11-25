/** Serialize engine placements for one owner-local day within this server process. */
const tails = new Map<string, Promise<void>>();

export async function withPlacementLock<T>(owner: string, day: string, fn: () => Promise<T>): Promise<T> {
  const key = `${owner}:${day}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  tails.set(key, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
