-- Every request rejection now carries a required reason (http/rejectBody.ts), stored as the row's
-- `decision_note` and sent to the requester. Overtime, remote work, late/early, asset requests and expenses
-- already had the column; these are the request tables that did not. Nullable: rows rejected before the reason
-- was required have none, and approved or pending rows never do.
ALTER TABLE `attendance_regularizations` ADD `decision_note` text;--> statement-breakpoint
ALTER TABLE `leave_encashments` ADD `decision_note` text;--> statement-breakpoint
ALTER TABLE `leave_requests` ADD `decision_note` text;--> statement-breakpoint
ALTER TABLE `loans` ADD `decision_note` text;--> statement-breakpoint
ALTER TABLE `reimbursements` ADD `decision_note` text;--> statement-breakpoint
ALTER TABLE `tax_declarations` ADD `decision_note` text;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `decision_note` text;