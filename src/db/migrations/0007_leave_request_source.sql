-- Where a leave request came from (src/db/schema.ts `leaveRequests.source`, opening-balances-plan.md): 'app' for
-- everything filed in HRMS, 'import' for leave taken before HRMS and brought in as history. Additive only:
-- every existing row is 'app', which is what it is.
ALTER TABLE `leave_requests` ADD `source` text DEFAULT 'app' NOT NULL;
