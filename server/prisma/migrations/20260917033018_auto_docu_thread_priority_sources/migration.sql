-- CreateTable
CREATE TABLE "thread_priority_sources" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "threadId" INTEGER NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "docId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "thread_priority_sources_threadId_idx" ON "thread_priority_sources"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "thread_priority_sources_threadId_docId_key" ON "thread_priority_sources"("threadId", "docId");
