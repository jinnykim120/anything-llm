-- Add the two new classification axes while preserving existing P4 data.
ALTER TABLE "document_classifications" ADD COLUMN "workType" TEXT;
ALTER TABLE "document_classifications" ADD COLUMN "businessUnit" TEXT;
