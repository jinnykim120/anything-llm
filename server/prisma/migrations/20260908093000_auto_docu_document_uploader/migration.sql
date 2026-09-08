-- Preserve who uploaded each workspace document and leave a future org-unit
-- snapshot column for the company directory integration.
ALTER TABLE "workspace_documents" ADD COLUMN "uploadedByUserId" INTEGER;
ALTER TABLE "workspace_documents" ADD COLUMN "uploadedByOrgUnit" TEXT;
