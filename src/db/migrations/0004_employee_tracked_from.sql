-- The day HRMS records start for each employee (src/db/schema.ts `employees.trackedFrom`,
-- opening-balances-plan.md). Additive and nullable: every existing row reads null, which means "records start on
-- the start date", so nothing about a live row changes until HR sets a date: in bulk for the people who joined
-- before go-live (`employees:setTrackedFrom`), or per person on the employee record.
ALTER TABLE `employees` ADD `tracked_from` integer;
