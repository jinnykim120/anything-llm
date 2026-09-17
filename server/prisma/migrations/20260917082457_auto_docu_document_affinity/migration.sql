-- CreateTable
CREATE TABLE "document_affinity" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "docIdA" TEXT NOT NULL,
    "docIdB" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 0,
    "occurrences" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "document_affinity_workspaceId_docIdA_idx" ON "document_affinity"("workspaceId", "docIdA");

-- CreateIndex
CREATE INDEX "document_affinity_workspaceId_docIdB_idx" ON "document_affinity"("workspaceId", "docIdB");

-- CreateIndex
CREATE UNIQUE INDEX "document_affinity_workspaceId_docIdA_docIdB_key" ON "document_affinity"("workspaceId", "docIdA", "docIdB");
