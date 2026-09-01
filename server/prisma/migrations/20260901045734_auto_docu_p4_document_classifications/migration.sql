-- CreateTable
CREATE TABLE "document_classifications" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "contentHash" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL DEFAULT 'unclassified',
    "docType" TEXT,
    "domain" TEXT,
    "tags" TEXT DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "rationale" TEXT,
    "source" TEXT,
    "sampleTitle" TEXT,
    "proposedBy" TEXT,
    "confirmedBy" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "document_classifications_contentHash_key" ON "document_classifications"("contentHash");
