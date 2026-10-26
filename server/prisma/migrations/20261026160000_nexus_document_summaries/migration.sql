-- CreateTable
CREATE TABLE "document_summaries" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "contentHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sourceChars" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "document_summaries_contentHash_key" ON "document_summaries"("contentHash");
