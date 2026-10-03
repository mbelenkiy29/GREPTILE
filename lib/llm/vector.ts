import { EMBEDDING_DIM } from "@/lib/db/schema";
import { LlmError } from "./types";

/**
 * Fits a provider vector into the fixed pgvector column. Shorter vectors are
 * zero-padded, which leaves cosine similarity unchanged; longer ones are rejected.
 */
export function toStoredEmbedding(v: number[]): number[] {
  if (v.length > EMBEDDING_DIM) {
    throw new LlmError(`embedding has ${v.length} dimensions; at most ${EMBEDDING_DIM} are supported`);
  }
  return v.length === EMBEDDING_DIM ? v : [...v, ...new Array<number>(EMBEDDING_DIM - v.length).fill(0)];
}
