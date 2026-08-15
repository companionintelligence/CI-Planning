/**
 * Embedding vector helpers, in one place because the codebase already carries two
 * different cosine functions and confusing them is a silent scoring bug: this is a
 * SIMILARITY in [-1,1], while triality's `squashedCosineDistance` is a squashed
 * DISTANCE and is NOT `1 − this`.
 *
 * Deliberately dependency-free and backend-agnostic. The `sqlite-vec` KNN path in
 * agents/groom.ts is an accelerator for thousands of vectors, and it is slated for
 * deletion at the Postgres cutover (see the note above `dedupeIdsViaVec`); anything
 * ranking a BOUNDED set — a per-owner exemplar index, say — should do it here in
 * plain arithmetic and stay portable.
 */

/** Cosine SIMILARITY in [-1,1] (1 = same direction, 0 = orthogonal). A zero-norm
 *  vector yields 0 via the `|| 1` denominator guard, never NaN. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * An embedding as stored: little-endian float32, the layout `sqlite-vec` expects, so
 * a stored vector stays readable if a KNN index is ever put in front of it.
 */
export function packVector(vec: number[]): Buffer {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/** Inverse of `packVector`. Returns null for a truncated or absent blob rather than
 *  a half-read vector — a silently short vector would score as a bad match, not an
 *  error, and quietly poison the ranking. */
export function unpackVector(buf: Buffer | Uint8Array | null | undefined): number[] | null {
  if (!buf || buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = new Array<number>(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}
