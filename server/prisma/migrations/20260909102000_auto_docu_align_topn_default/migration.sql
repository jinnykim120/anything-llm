UPDATE workspaces
SET topN = 12
WHERE topN IS NULL OR topN = 4;
