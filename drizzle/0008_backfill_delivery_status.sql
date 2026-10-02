-- Deliveries recorded before outcomes were tracked were only written after routing succeeded: mark them accepted.
UPDATE "webhook_deliveries"
SET "status" = 'accepted', "processed_at" = "received_at", "last_attempt_at" = "received_at"
WHERE "status" = 'processing' AND "processed_at" IS NULL;
