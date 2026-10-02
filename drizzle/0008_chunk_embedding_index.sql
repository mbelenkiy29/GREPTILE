CREATE INDEX IF NOT EXISTS "file_chunks_embedding_hnsw" ON "file_chunks" USING hnsw ("embedding" vector_cosine_ops);
