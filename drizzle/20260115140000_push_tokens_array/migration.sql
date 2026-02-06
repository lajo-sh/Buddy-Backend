-- Convert push_token from text to text[] array
-- First, create the new column
ALTER TABLE "users" ADD COLUMN "push_tokens" text[] DEFAULT '{}';--> statement-breakpoint

-- Migrate existing single token to array format (skip null values)
UPDATE "users" SET "push_tokens" = ARRAY[push_token]::text[] WHERE push_token IS NOT NULL;--> statement-breakpoint

-- Drop the old column
ALTER TABLE "users" DROP COLUMN "push_token";
