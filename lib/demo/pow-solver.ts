/**
 * The proof-of-work solver that runs in the visitor's browser (R3.7), with Web Crypto (SubtleCrypto) only — no Node
 * modules, so it is safe in client bundles. It yields to the event loop regularly so the page stays responsive.
 */

/** Number of leading zero bits of `hash`. */
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Finds a counter such that SHA-256(`<token>:<counter>`) starts with `difficulty` zero bits. `onProgress` gets the
 * number of hashes tried so far; `signal` stops the search.
 */
export async function solveChallenge(token: string, difficulty: number, opts: { onProgress?: (tried: number) => void; signal?: AbortSignal; maxTries?: number } = {}): Promise<string> {
  const encoder = new TextEncoder();
  const max = opts.maxTries ?? 2 ** 32;
  for (let i = 0; i < max; i++) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(`${token}:${i}`)));
    if (leadingZeroBits(digest) >= difficulty) return String(i);
    if (i % 2048 === 2047) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      opts.onProgress?.(i + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error("no solution found");
}
