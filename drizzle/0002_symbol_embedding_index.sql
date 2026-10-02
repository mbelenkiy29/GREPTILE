CREATE INDEX IF NOT EXISTS "symbols_embedding_hnsw" ON "symbols" USING hnsw ("embedding" vector_cosine_ops);
