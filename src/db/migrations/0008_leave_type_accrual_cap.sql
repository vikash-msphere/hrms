-- A leave type's accrual cap: the most a balance of that type may accrue to (db/schema.ts `accrualCapDays`).
-- Nullable with no default, so every existing type reads as uncapped and accrues exactly as it did before.
ALTER TABLE `leave_types` ADD `accrual_cap_days` real;
