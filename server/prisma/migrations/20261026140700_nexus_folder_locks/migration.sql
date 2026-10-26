-- AlterTable
ALTER TABLE "workspace_threads" ADD COLUMN "client_id" TEXT;
ALTER TABLE "workspace_chats" ADD COLUMN "client_id" TEXT;

-- CreateTable
CREATE TABLE "folder_locks" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "folder" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdByClient" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "folder_unlocks" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "access_admins" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "workspace_threads_client_id_idx" ON "workspace_threads"("client_id");
CREATE UNIQUE INDEX "folder_locks_folder_key" ON "folder_locks"("folder");
CREATE UNIQUE INDEX "folder_unlocks_clientId_folder_key" ON "folder_unlocks"("clientId", "folder");
CREATE INDEX "folder_unlocks_clientId_idx" ON "folder_unlocks"("clientId");
CREATE UNIQUE INDEX "access_admins_clientId_key" ON "access_admins"("clientId");
