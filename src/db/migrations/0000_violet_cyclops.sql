CREATE TABLE `access_rules` (
	`uuid` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`subject_kind` text NOT NULL,
	`namespace` text NOT NULL,
	`pattern` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_code` text DEFAULT '' NOT NULL,
	`match_code` text,
	`level` text,
	`effect` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ar_subject_ns_match_idx` ON `access_rules` (`subject`,`namespace`,`match_code`);--> statement-breakpoint
CREATE TABLE `announcement_poll_options` (
	`uuid` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`label` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `apo_ann_idx` ON `announcement_poll_options` (`announcement_id`);--> statement-breakpoint
CREATE TABLE `announcement_poll_votes` (
	`uuid` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`option_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`option_id`) REFERENCES `announcement_poll_options`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `apv_ann_idx` ON `announcement_poll_votes` (`announcement_id`);--> statement-breakpoint
CREATE INDEX `apv_emp_idx` ON `announcement_poll_votes` (`employee_id`);--> statement-breakpoint
CREATE INDEX `apv_opt_idx` ON `announcement_poll_votes` (`option_id`);--> statement-breakpoint
CREATE TABLE `announcement_reactions` (
	`uuid` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`reply_id` text,
	`employee_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_id`) REFERENCES `announcement_replies`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arx_ann_idx` ON `announcement_reactions` (`announcement_id`);--> statement-breakpoint
CREATE INDEX `arx_emp_idx` ON `announcement_reactions` (`employee_id`);--> statement-breakpoint
CREATE INDEX `arx_reply_idx` ON `announcement_reactions` (`reply_id`);--> statement-breakpoint
CREATE TABLE `announcement_reads` (
	`uuid` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ar_ann_idx` ON `announcement_reads` (`announcement_id`);--> statement-breakpoint
CREATE INDEX `ar_emp_idx` ON `announcement_reads` (`employee_id`);--> statement-breakpoint
CREATE TABLE `announcement_replies` (
	`uuid` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`author_id` text,
	`author_email` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arp_ann_idx` ON `announcement_replies` (`announcement_id`);--> statement-breakpoint
CREATE TABLE `announcements` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`kind` text DEFAULT 'announcement' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`author_employee_id` text,
	`publish_time` integer,
	`published` integer DEFAULT true NOT NULL,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`poll_multiple` integer DEFAULT false NOT NULL,
	`poll_closes_at` integer,
	`pinned_at` integer,
	`recipient_employee_id` text,
	`recipient_department_id` text,
	`value` text,
	`category` text,
	`level` text,
	`body_text` text DEFAULT '' NOT NULL,
	`title_align` text,
	`body_valign` text,
	`illustration` text,
	`illustration_layout` text,
	`recipient_layout` text,
	`points` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcements_code_unique` ON `announcements` (`code`);--> statement-breakpoint
CREATE TABLE `applications` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`candidate_id` text NOT NULL,
	`requisition_id` text NOT NULL,
	`stage` text DEFAULT 'applied' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`rejection_reason` text,
	`source` text,
	`referral_id` text,
	`applied_date` integer,
	`stage_changed_date` integer,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requisition_id`) REFERENCES `job_requisitions`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_code_unique` ON `applications` (`code`);--> statement-breakpoint
CREATE INDEX `application_candidate_idx` ON `applications` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `application_requisition_idx` ON `applications` (`requisition_id`);--> statement-breakpoint
CREATE TABLE `approval_delegations` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`delegator_id` text NOT NULL,
	`delegate_id` text NOT NULL,
	`from_date` integer NOT NULL,
	`to_date` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`delegator_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delegate_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_delegations_code_unique` ON `approval_delegations` (`code`);--> statement-breakpoint
CREATE INDEX `appdel_delegator_idx` ON `approval_delegations` (`delegator_id`);--> statement-breakpoint
CREATE INDEX `appdel_delegate_idx` ON `approval_delegations` (`delegate_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`asset_tag` text,
	`name` text NOT NULL,
	`category` text,
	`serial_number` text,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`assigned_to` text,
	`assigned_on` integer,
	`purchase_date` integer,
	`tag_printed_at` integer,
	`verified_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`assigned_to`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_code_unique` ON `assets` (`code`);--> statement-breakpoint
CREATE INDEX `asset_assigned_idx` ON `assets` (`assigned_to`);--> statement-breakpoint
CREATE INDEX `asset_status_idx` ON `assets` (`status`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`collection` text NOT NULL,
	`object_id` text NOT NULL,
	`slot` text DEFAULT '' NOT NULL,
	`r2_key` text NOT NULL,
	`file_name` text,
	`content_type` text,
	`size_bytes` integer,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attach_target_idx` ON `attachments` (`collection`,`object_id`,`slot`);--> statement-breakpoint
CREATE TABLE `attendance_regularizations` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`date` integer NOT NULL,
	`sessions` text NOT NULL,
	`reason` text,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_regularizations_code_unique` ON `attendance_regularizations` (`code`);--> statement-breakpoint
CREATE INDEX `attreg_emp_idx` ON `attendance_regularizations` (`employee_id`);--> statement-breakpoint
CREATE INDEX `attreg_state_idx` ON `attendance_regularizations` (`state`);--> statement-breakpoint
CREATE TABLE `attendance_sessions` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`clock_in` integer NOT NULL,
	`clock_out` integer,
	`source` text DEFAULT 'clock' NOT NULL,
	`superseded_by` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `attendance_regularizations`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_sessions_code_unique` ON `attendance_sessions` (`code`);--> statement-breakpoint
CREATE INDEX `att_emp_idx` ON `attendance_sessions` (`employee_id`);--> statement-breakpoint
CREATE INDEX `att_open_idx` ON `attendance_sessions` (`clock_out`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`actor_email` text NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`entity_name` text,
	`meta` text,
	`ip` text,
	`user_agent` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_code_unique` ON `audit_log` (`code`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`automation_id` text NOT NULL,
	`event_id` text,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`subject` text,
	`employee_id` text,
	`correlation_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `event_log`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_code_unique` ON `automation_runs` (`code`);--> statement-breakpoint
CREATE INDEX `automation_runs_auto_idx` ON `automation_runs` (`automation_id`);--> statement-breakpoint
CREATE INDEX `automation_runs_started_idx` ON `automation_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_corr_idx` ON `automation_runs` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`description` text,
	`trigger_type` text NOT NULL,
	`condition_json` text,
	`actions_json` text NOT NULL,
	`schedule_json` text,
	`last_scheduled_on` text,
	`enabled` integer DEFAULT true NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automations_code_unique` ON `automations` (`code`);--> statement-breakpoint
CREATE INDEX `automations_trigger_idx` ON `automations` (`trigger_type`);--> statement-breakpoint
CREATE TABLE `background_checks` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`transition_id` text,
	`check_type` text DEFAULT 'identity' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`vendor` text,
	`reference_no` text,
	`initiated_date` integer,
	`completed_date` integer,
	`notes` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transition_id`) REFERENCES `transitions`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_checks_code_unique` ON `background_checks` (`code`);--> statement-breakpoint
CREATE INDEX `bgcheck_emp_idx` ON `background_checks` (`employee_id`);--> statement-breakpoint
CREATE TABLE `benefit_enrollments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`status` text DEFAULT 'enrolled' NOT NULL,
	`effective_date` integer,
	`dependents_json` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `benefit_plans`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benefit_enrollments_code_unique` ON `benefit_enrollments` (`code`);--> statement-breakpoint
CREATE INDEX `ben_emp_idx` ON `benefit_enrollments` (`employee_id`);--> statement-breakpoint
CREATE INDEX `ben_plan_idx` ON `benefit_enrollments` (`plan_id`);--> statement-breakpoint
CREATE TABLE `benefit_plans` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`category` text DEFAULT 'health' NOT NULL,
	`description` text,
	`provider` text,
	`employee_cost` real DEFAULT 0 NOT NULL,
	`employer_cost` real DEFAULT 0 NOT NULL,
	`cost_period` text DEFAULT 'month' NOT NULL,
	`allows_dependents` integer DEFAULT false NOT NULL,
	`auto_enroll` integer DEFAULT false NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benefit_plans_code_unique` ON `benefit_plans` (`code`);--> statement-breakpoint
CREATE TABLE `boards` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`description` text,
	`task_prefix` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'kanban' NOT NULL,
	`columns_json` text DEFAULT '[]' NOT NULL,
	`swimlane_mode` text DEFAULT 'none' NOT NULL,
	`swimlanes_json` text DEFAULT '[]' NOT NULL,
	`no_lane_label` text,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`hide_empty_lanes` integer DEFAULT false NOT NULL,
	`reassign_lane_on_move` integer DEFAULT false NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_code_unique` ON `boards` (`code`);--> statement-breakpoint
CREATE TABLE `bonuses` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`kind` text,
	`reason` text,
	`award_date` integer NOT NULL,
	`scope` text,
	`scope_ref` text,
	`batch_id` text,
	`paid_run_id` text,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bonuses_code_unique` ON `bonuses` (`code`);--> statement-breakpoint
CREATE INDEX `bonus_emp_idx` ON `bonuses` (`employee_id`);--> statement-breakpoint
CREATE INDEX `bonus_batch_idx` ON `bonuses` (`batch_id`);--> statement-breakpoint
CREATE INDEX `bonus_paid_idx` ON `bonuses` (`paid_run_id`);--> statement-breakpoint
CREATE TABLE `candidates` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`source` text,
	`source_detail` text,
	`referral_id` text,
	`tags` text,
	`notes` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_code_unique` ON `candidates` (`code`);--> statement-breakpoint
CREATE INDEX `candidate_email_idx` ON `candidates` (`email`);--> statement-breakpoint
CREATE TABLE `card_comments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`author_id` text,
	`author_email` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cardcomment_card_idx` ON `card_comments` (`card_id`);--> statement-breakpoint
CREATE TABLE `card_movements` (
	`uuid` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`board_id` text NOT NULL,
	`from_column` text,
	`to_column` text NOT NULL,
	`actor_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cardmove_board_idx` ON `card_movements` (`board_id`);--> statement-breakpoint
CREATE INDEX `cardmove_card_idx` ON `card_movements` (`card_id`);--> statement-breakpoint
CREATE TABLE `card_todos` (
	`uuid` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ct_card_idx` ON `card_todos` (`card_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`board_id` text NOT NULL,
	`seq` integer,
	`key_prefix` text,
	`sprint_id` text,
	`employee_id` text NOT NULL,
	`department_id` text,
	`column_key` text NOT NULL,
	`swimlane_key` text,
	`rank` real DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`assignee_id` text,
	`priority` text DEFAULT 'medium' NOT NULL,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`documents_json` text DEFAULT '[]' NOT NULL,
	`size` integer,
	`due_date` integer,
	`blocked` integer DEFAULT false NOT NULL,
	`block_reason` text,
	`blocked_by_id` text,
	`goal_id` text,
	`committed_at` integer,
	`started_at` integer,
	`delivered_at` integer,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sprint_id`) REFERENCES `sprints`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_by_id`) REFERENCES `cards`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_code_unique` ON `cards` (`code`);--> statement-breakpoint
CREATE INDEX `card_board_idx` ON `cards` (`board_id`);--> statement-breakpoint
CREATE INDEX `card_emp_idx` ON `cards` (`employee_id`);--> statement-breakpoint
CREATE INDEX `card_dept_idx` ON `cards` (`department_id`);--> statement-breakpoint
CREATE INDEX `card_assignee_idx` ON `cards` (`assignee_id`);--> statement-breakpoint
CREATE INDEX `card_goal_idx` ON `cards` (`goal_id`);--> statement-breakpoint
CREATE TABLE `check_ins` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`counterpart_id` text,
	`meeting_date` integer,
	`notes` text,
	`action_items_json` text,
	`cadence` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counterpart_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_ins_code_unique` ON `check_ins` (`code`);--> statement-breakpoint
CREATE INDEX `ci_emp_idx` ON `check_ins` (`employee_id`);--> statement-breakpoint
CREATE TABLE `compensation` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`ctc_annual` real DEFAULT 0 NOT NULL,
	`base_pay` real NOT NULL,
	`special_allowance` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`pay_grade_id` text,
	`structure_id` text,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`arrears_amount` real DEFAULT 0 NOT NULL,
	`arrears_paid_run_id` text,
	`arrears_paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pay_grade_id`) REFERENCES `pay_grades`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`structure_id`) REFERENCES `salary_structures`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`arrears_paid_run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compensation_code_unique` ON `compensation` (`code`);--> statement-breakpoint
CREATE INDEX `comp_emp_idx` ON `compensation` (`employee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `comp_open_idx` ON `compensation` (`employee_id`) WHERE "compensation"."effective_to" is null;--> statement-breakpoint
CREATE TABLE `compliance_events` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`title` text NOT NULL,
	`category` text,
	`frequency` text DEFAULT 'one_time' NOT NULL,
	`due_date` integer NOT NULL,
	`period_label` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`filed_date` integer,
	`reference` text,
	`assignee_id` text,
	`notes` text,
	`rule_id` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`) REFERENCES `compliance_rules`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_events_code_unique` ON `compliance_events` (`code`);--> statement-breakpoint
CREATE INDEX `compliance_due_idx` ON `compliance_events` (`due_date`);--> statement-breakpoint
CREATE INDEX `compliance_rule_idx` ON `compliance_events` (`rule_id`);--> statement-breakpoint
CREATE TABLE `compliance_rules` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`title` text NOT NULL,
	`category` text,
	`frequency` text DEFAULT 'monthly' NOT NULL,
	`due_day` integer DEFAULT 1 NOT NULL,
	`anchor_month` integer,
	`assignee_id` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_rules_code_unique` ON `compliance_rules` (`code`);--> statement-breakpoint
CREATE TABLE `cron_runs` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`cron` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`error` text,
	`summary_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_runs_code_unique` ON `cron_runs` (`code`);--> statement-breakpoint
CREATE INDEX `cron_runs_cron_idx` ON `cron_runs` (`cron`);--> statement-breakpoint
CREATE INDEX `cron_runs_started_idx` ON `cron_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `departments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`parent_id` text,
	`manager_ids` text,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `departments_code_unique` ON `departments` (`code`);--> statement-breakpoint
CREATE TABLE `dependents` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`name` text NOT NULL,
	`relationship` text DEFAULT 'other' NOT NULL,
	`date_of_birth` integer,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependents_code_unique` ON `dependents` (`code`);--> statement-breakpoint
CREATE INDEX `dep_emp_idx` ON `dependents` (`employee_id`);--> statement-breakpoint
CREATE TABLE `document_acknowledgements` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`document_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`signature` text NOT NULL,
	`signed_doc_id` text,
	`acknowledged_time` integer,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `org_documents`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`signed_doc_id`) REFERENCES `personal_documents`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_acknowledgements_code_unique` ON `document_acknowledgements` (`code`);--> statement-breakpoint
CREATE INDEX `dack_emp_idx` ON `document_acknowledgements` (`employee_id`);--> statement-breakpoint
CREATE INDEX `dack_doc_idx` ON `document_acknowledgements` (`document_id`);--> statement-breakpoint
CREATE TABLE `employees` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_number` text,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`legal_name` text,
	`work_email` text NOT NULL,
	`job_title` text,
	`bio` text,
	`department_id` text,
	`manager_id` text,
	`start_date` integer,
	`end_date` integer,
	`probation_end_date` integer,
	`epf_enrolled` integer DEFAULT false NOT NULL,
	`national_id_enc` text,
	`bank_details_enc` text,
	`identity_details_enc` text,
	`personal_details_enc` text,
	`tax_details_enc` text,
	`photo_key` text,
	`signature_key` text,
	`notification_prefs` text,
	`status` text DEFAULT 'active' NOT NULL,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`manager_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employees_code_unique` ON `employees` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `employees_employee_number_unique` ON `employees` (`employee_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `employees_work_email_unique` ON `employees` (`work_email`);--> statement-breakpoint
CREATE INDEX `emp_dept_idx` ON `employees` (`department_id`);--> statement-breakpoint
CREATE INDEX `emp_mgr_idx` ON `employees` (`manager_id`);--> statement-breakpoint
CREATE TABLE `event_log` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`type` text NOT NULL,
	`subject` text,
	`actor_id` text,
	`employee_id` text,
	`payload_json` text,
	`correlation_id` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_log_code_unique` ON `event_log` (`code`);--> statement-breakpoint
CREATE INDEX `event_log_type_idx` ON `event_log` (`type`);--> statement-breakpoint
CREATE INDEX `event_log_occurred_idx` ON `event_log` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `event_log_corr_idx` ON `event_log` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`title` text NOT NULL,
	`start_date` integer NOT NULL,
	`end_date` integer NOT NULL,
	`all_day` integer DEFAULT true NOT NULL,
	`count_as_work` integer DEFAULT false NOT NULL,
	`color` text,
	`description` text,
	`attendee_ids` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_code_unique` ON `events` (`code`);--> statement-breakpoint
CREATE INDEX `event_start_idx` ON `events` (`start_date`);--> statement-breakpoint
CREATE TABLE `expense_budgets` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`department_id` text,
	`category_id` text,
	`period_type` text NOT NULL,
	`period_key` text NOT NULL,
	`amount` real NOT NULL,
	`alert_level` integer DEFAULT 0 NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_budgets_code_unique` ON `expense_budgets` (`code`);--> statement-breakpoint
CREATE INDEX `expbudget_period_idx` ON `expense_budgets` (`period_type`,`period_key`);--> statement-breakpoint
CREATE TABLE `expense_categories` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`requires_receipt` integer DEFAULT false NOT NULL,
	`gl_code` text,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_categories_code_unique` ON `expense_categories` (`code`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`vendor_id` text,
	`category_id` text,
	`department_id` text,
	`amount` real NOT NULL,
	`tax_amount` real DEFAULT 0 NOT NULL,
	`incurred_on` integer,
	`description` text,
	`invoice_number` text,
	`payment_method` text,
	`payment_ref` text,
	`state` text DEFAULT 'DRAFT' NOT NULL,
	`reimbursable` integer DEFAULT false NOT NULL,
	`reimbursement_id` text,
	`decided_by` text,
	`paid_by` text,
	`paid_at` integer,
	`is_recurring` integer DEFAULT false NOT NULL,
	`recurrence_rule` text,
	`next_occurrence_on` integer,
	`last_generated_on` integer,
	`template_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reimbursement_id`) REFERENCES `reimbursements`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `expenses`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_code_unique` ON `expenses` (`code`);--> statement-breakpoint
CREATE INDEX `exp_emp_idx` ON `expenses` (`employee_id`);--> statement-breakpoint
CREATE INDEX `exp_state_idx` ON `expenses` (`state`);--> statement-breakpoint
CREATE INDEX `exp_dept_idx` ON `expenses` (`department_id`);--> statement-breakpoint
CREATE INDEX `exp_cat_idx` ON `expenses` (`category_id`);--> statement-breakpoint
CREATE INDEX `exp_vendor_idx` ON `expenses` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`description` text,
	`weight` integer DEFAULT 0 NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`due_date` integer,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `goals`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goals_code_unique` ON `goals` (`code`);--> statement-breakpoint
CREATE INDEX `goal_emp_idx` ON `goals` (`employee_id`);--> statement-breakpoint
CREATE INDEX `goal_parent_idx` ON `goals` (`parent_id`);--> statement-breakpoint
CREATE TABLE `holiday_selections` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`holiday_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holiday_id`) REFERENCES `holidays`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holiday_selections_code_unique` ON `holiday_selections` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `hsel_emp_holiday_idx` ON `holiday_selections` (`employee_id`,`holiday_id`);--> statement-breakpoint
CREATE TABLE `holidays` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`date` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'fixed' NOT NULL,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holidays_code_unique` ON `holidays` (`code`);--> statement-breakpoint
CREATE TABLE `interview_feedback` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`interview_id` text NOT NULL,
	`author_id` text NOT NULL,
	`ratings_json` text,
	`overall_rating` integer,
	`recommendation` text,
	`comment` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`interview_id`) REFERENCES `interviews`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_feedback_code_unique` ON `interview_feedback` (`code`);--> statement-breakpoint
CREATE INDEX `if_interview_idx` ON `interview_feedback` (`interview_id`);--> statement-breakpoint
CREATE INDEX `if_author_idx` ON `interview_feedback` (`author_id`);--> statement-breakpoint
CREATE TABLE `interviews` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`application_id` text NOT NULL,
	`title` text NOT NULL,
	`mode` text DEFAULT 'video' NOT NULL,
	`scheduled_start` integer,
	`scheduled_end` integer,
	`interviewer_ids` text,
	`location` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interviews_code_unique` ON `interviews` (`code`);--> statement-breakpoint
CREATE INDEX `interview_application_idx` ON `interviews` (`application_id`);--> statement-breakpoint
CREATE TABLE `job_requisitions` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`title` text NOT NULL,
	`department_id` text,
	`hiring_manager_id` text,
	`location` text,
	`employment_type` text,
	`openings` integer DEFAULT 1 NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`opened_date` integer,
	`closed_date` integer,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hiring_manager_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_requisitions_code_unique` ON `job_requisitions` (`code`);--> statement-breakpoint
CREATE INDEX `requisition_dept_idx` ON `job_requisitions` (`department_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_by` text,
	`employee_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`result_json` text,
	`run_after` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_code_unique` ON `jobs` (`code`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `leave_balances` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`balance_days` real DEFAULT 0 NOT NULL,
	`last_accrual_ym` text,
	`last_carry_forward_year` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_balances_code_unique` ON `leave_balances` (`code`);--> statement-breakpoint
CREATE INDEX `bal_emp_idx` ON `leave_balances` (`employee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bal_emp_type_idx` ON `leave_balances` (`employee_id`,`leave_type_id`);--> statement-breakpoint
CREATE TABLE `leave_encashments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`days` real NOT NULL,
	`rate_per_day` real NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`decided_by` text,
	`paid_run_id` text,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_encashments_code_unique` ON `leave_encashments` (`code`);--> statement-breakpoint
CREATE INDEX `encash_emp_idx` ON `leave_encashments` (`employee_id`);--> statement-breakpoint
CREATE INDEX `encash_state_idx` ON `leave_encashments` (`state`);--> statement-breakpoint
CREATE TABLE `leave_requests` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`start_date` integer NOT NULL,
	`end_date` integer NOT NULL,
	`days` real NOT NULL,
	`start_session` integer DEFAULT 1 NOT NULL,
	`end_session` integer DEFAULT 2 NOT NULL,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`reason` text,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_requests_code_unique` ON `leave_requests` (`code`);--> statement-breakpoint
CREATE INDEX `lr_emp_idx` ON `leave_requests` (`employee_id`);--> statement-breakpoint
CREATE INDEX `lr_state_idx` ON `leave_requests` (`state`);--> statement-breakpoint
CREATE TABLE `leave_types` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`accrual_days_per_year` real DEFAULT 0 NOT NULL,
	`accrual_frequency` text DEFAULT 'monthly' NOT NULL,
	`paid` integer DEFAULT true NOT NULL,
	`color` text,
	`available_during_probation` integer DEFAULT true NOT NULL,
	`probation_accrual_days_per_year` real DEFAULT 0 NOT NULL,
	`probation_cap_days` real,
	`encashable` integer DEFAULT false NOT NULL,
	`encashment_cap_days_per_year` real,
	`min_balance_retained_days` real DEFAULT 0 NOT NULL,
	`carry_forward` integer DEFAULT false NOT NULL,
	`carry_forward_cap_days` real,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_types_code_unique` ON `leave_types` (`code`);--> statement-breakpoint
CREATE TABLE `letter_templates` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`label` text NOT NULL,
	`category` text,
	`filename` text,
	`inputs` text,
	`blocks` text NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `letter_templates_code_unique` ON `letter_templates` (`code`);--> statement-breakpoint
CREATE TABLE `loan_repayments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`loan_id` text NOT NULL,
	`run_id` text,
	`amount` real NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`loan_id`) REFERENCES `loans`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `loan_repayment_loan_idx` ON `loan_repayments` (`loan_id`);--> statement-breakpoint
CREATE INDEX `loan_repayment_run_idx` ON `loan_repayments` (`run_id`);--> statement-breakpoint
CREATE TABLE `loans` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`kind` text DEFAULT 'loan' NOT NULL,
	`principal` real DEFAULT 0 NOT NULL,
	`installments` integer DEFAULT 1 NOT NULL,
	`monthly_amount` real DEFAULT 0 NOT NULL,
	`repaid` real DEFAULT 0 NOT NULL,
	`reason` text,
	`start_date` integer,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`decided_by` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loans_code_unique` ON `loans` (`code`);--> statement-breakpoint
CREATE INDEX `loan_emp_idx` ON `loans` (`employee_id`);--> statement-breakpoint
CREATE TABLE `notice_periods` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`type` text DEFAULT 'resignation' NOT NULL,
	`notice_date` integer NOT NULL,
	`last_working_day` integer NOT NULL,
	`status` text DEFAULT 'serving' NOT NULL,
	`reason` text,
	`notes` text,
	`transition_id` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transition_id`) REFERENCES `transitions`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notice_periods_code_unique` ON `notice_periods` (`code`);--> statement-breakpoint
CREATE INDEX `notice_emp_idx` ON `notice_periods` (`employee_id`);--> statement-breakpoint
CREATE INDEX `notice_status_idx` ON `notice_periods` (`status`);--> statement-breakpoint
CREATE TABLE `notification_digest_queue` (
	`uuid` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notif_digest_recipient_idx` ON `notification_digest_queue` (`recipient_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`recipient_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`subject` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`action` text,
	`actor_id` text,
	`actor_name` text,
	`snooze_until` integer,
	`dismissed_time` integer,
	`read_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_code_unique` ON `notifications` (`code`);--> statement-breakpoint
CREATE INDEX `notif_recipient_idx` ON `notifications` (`recipient_id`);--> statement-breakpoint
CREATE INDEX `notif_read_idx` ON `notifications` (`read_time`);--> statement-breakpoint
CREATE TABLE `offers` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`application_id` text NOT NULL,
	`base_comp` real,
	`currency` text DEFAULT 'INR' NOT NULL,
	`offer_date` integer,
	`join_date` integer,
	`expiry_date` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`approver_id` text,
	`notes` text,
	`created_employee_id` text,
	`transition_id` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approver_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transition_id`) REFERENCES `transitions`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offers_code_unique` ON `offers` (`code`);--> statement-breakpoint
CREATE INDEX `offer_application_idx` ON `offers` (`application_id`);--> statement-breakpoint
CREATE TABLE `org_documents` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`document_type` text NOT NULL,
	`title` text NOT NULL,
	`file_name` text,
	`r2_key` text NOT NULL,
	`content_type` text,
	`size_bytes` integer,
	`published` integer DEFAULT true NOT NULL,
	`expire_time` integer,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`requires_ack` integer DEFAULT false NOT NULL,
	`ack_version` integer DEFAULT 1 NOT NULL,
	`ack_method` text,
	`sign_anchor_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_documents_code_unique` ON `org_documents` (`code`);--> statement-breakpoint
CREATE TABLE `overtime_requests` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`date` integer NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer NOT NULL,
	`reason` text,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`paid_run_id` text,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `overtime_requests_code_unique` ON `overtime_requests` (`code`);--> statement-breakpoint
CREATE INDEX `ot_emp_idx` ON `overtime_requests` (`employee_id`);--> statement-breakpoint
CREATE INDEX `ot_state_idx` ON `overtime_requests` (`state`);--> statement-breakpoint
CREATE TABLE `pay_components` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`method` text DEFAULT 'fixed' NOT NULL,
	`rate` real,
	`cap` real,
	`regime` text,
	`recurring` integer DEFAULT true NOT NULL,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_components_code_unique` ON `pay_components` (`code`);--> statement-breakpoint
CREATE TABLE `pay_grades` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`band_min` real,
	`band_mid` real,
	`band_max` real,
	`currency` text DEFAULT 'INR' NOT NULL,
	`description` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_grades_code_unique` ON `pay_grades` (`code`);--> statement-breakpoint
CREATE TABLE `pay_periods` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`label` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`pay_date` integer NOT NULL,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_periods_code_unique` ON `pay_periods` (`code`);--> statement-breakpoint
CREATE TABLE `payroll_run_items` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`lines_json` text NOT NULL,
	`gross` real NOT NULL,
	`taxable_gross` real DEFAULT 0 NOT NULL,
	`total_deductions` real NOT NULL,
	`tax` real DEFAULT 0 NOT NULL,
	`net` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_run_items_code_unique` ON `payroll_run_items` (`code`);--> statement-breakpoint
CREATE INDEX `rri_run_idx` ON `payroll_run_items` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rri_run_emp_idx` ON `payroll_run_items` (`run_id`,`employee_id`);--> statement-breakpoint
CREATE TABLE `payroll_runs` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`pay_period_id` text NOT NULL,
	`state` text DEFAULT 'DRAFT' NOT NULL,
	`created_by` text,
	`submitted_by` text,
	`approved_by` text,
	`lock_time` integer,
	`items_built_at` integer,
	`bank_file_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pay_period_id`) REFERENCES `pay_periods`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_runs_code_unique` ON `payroll_runs` (`code`);--> statement-breakpoint
CREATE INDEX `run_period_idx` ON `payroll_runs` (`pay_period_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_period_committed_idx` ON `payroll_runs` (`pay_period_id`) WHERE "payroll_runs"."state" in ('APPROVED', 'PUBLISHED');--> statement-breakpoint
CREATE TABLE `payslips` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`run_id` text NOT NULL,
	`run_item_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`gross` real DEFAULT 0 NOT NULL,
	`taxable_gross` real DEFAULT 0 NOT NULL,
	`total_deductions` real DEFAULT 0 NOT NULL,
	`tax` real DEFAULT 0 NOT NULL,
	`net` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_item_id`) REFERENCES `payroll_run_items`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payslips_code_unique` ON `payslips` (`code`);--> statement-breakpoint
CREATE INDEX `payslip_emp_idx` ON `payslips` (`employee_id`);--> statement-breakpoint
CREATE INDEX `payslip_run_idx` ON `payslips` (`run_id`);--> statement-breakpoint
CREATE TABLE `personal_documents` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`source_doc_id` text,
	`ack_id` text,
	`requires_signature` integer DEFAULT false NOT NULL,
	`signed_time` integer,
	`signature_name` text,
	`financial_year` text,
	`official` integer DEFAULT false NOT NULL,
	`esign_provider` text,
	`esign_request_id` text,
	`esign_status` text DEFAULT 'none' NOT NULL,
	`esign_url` text,
	`esign_sent_at` integer,
	`esign_signed_at` integer,
	`document_type` text NOT NULL,
	`title` text NOT NULL,
	`file_name` text,
	`r2_key` text NOT NULL,
	`content_type` text,
	`size_bytes` integer,
	`published` integer DEFAULT true NOT NULL,
	`expire_time` integer,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_doc_id`) REFERENCES `org_documents`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ack_id`) REFERENCES `document_acknowledgements`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_documents_code_unique` ON `personal_documents` (`code`);--> statement-breakpoint
CREATE INDEX `pdoc_emp_idx` ON `personal_documents` (`employee_id`);--> statement-breakpoint
CREATE INDEX `pdoc_esign_ref_idx` ON `personal_documents` (`esign_request_id`);--> statement-breakpoint
CREATE TABLE `policy` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`job_title` text,
	`department_id` text,
	`location` text,
	`note` text,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `positions_code_unique` ON `positions` (`code`);--> statement-breakpoint
CREATE INDEX `pos_emp_idx` ON `positions` (`employee_id`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preferences_code_unique` ON `preferences` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `pref_user_key_idx` ON `preferences` (`user_id`,`key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`client` text,
	`project_code` text,
	`billable` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_code_unique` ON `projects` (`code`);--> statement-breakpoint
CREATE TABLE `referrals` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`referrer_id` text NOT NULL,
	`candidate_name` text NOT NULL,
	`candidate_email` text,
	`candidate_phone` text,
	`position_title` text,
	`department_id` text,
	`notes` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`hired_employee_id` text,
	`bonus_id` text,
	`bonus_status` text DEFAULT 'pending' NOT NULL,
	`bonus_amount` real,
	`bonus_eligible_date` integer,
	`bonus_paid_date` integer,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`referrer_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hired_employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bonus_id`) REFERENCES `bonuses`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referrals_code_unique` ON `referrals` (`code`);--> statement-breakpoint
CREATE INDEX `referral_referrer_idx` ON `referrals` (`referrer_id`);--> statement-breakpoint
CREATE INDEX `referral_hired_idx` ON `referrals` (`hired_employee_id`);--> statement-breakpoint
CREATE TABLE `reimbursement_categories` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`requires_receipt` integer DEFAULT false NOT NULL,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reimbursement_categories_code_unique` ON `reimbursement_categories` (`code`);--> statement-breakpoint
CREATE TABLE `reimbursements` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`category_id` text,
	`amount` real NOT NULL,
	`incurred_on` integer,
	`description` text,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`decided_by` text,
	`paid_run_id` text,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `reimbursement_categories`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_run_id`) REFERENCES `payroll_runs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reimbursements_code_unique` ON `reimbursements` (`code`);--> statement-breakpoint
CREATE INDEX `reimb_emp_idx` ON `reimbursements` (`employee_id`);--> statement-breakpoint
CREATE INDEX `reimb_state_idx` ON `reimbursements` (`state`);--> statement-breakpoint
CREATE TABLE `remote_work_requests` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`start_date` integer NOT NULL,
	`end_date` integer NOT NULL,
	`start_session` integer DEFAULT 1 NOT NULL,
	`end_session` integer DEFAULT 2 NOT NULL,
	`location` text,
	`reason` text,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_work_requests_code_unique` ON `remote_work_requests` (`code`);--> statement-breakpoint
CREATE INDEX `rwr_emp_idx` ON `remote_work_requests` (`employee_id`);--> statement-breakpoint
CREATE INDEX `rwr_state_idx` ON `remote_work_requests` (`state`);--> statement-breakpoint
CREATE TABLE `review_cycles` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`self_due_date` integer,
	`manager_due_date` integer,
	`state` text DEFAULT 'DRAFT' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_cycles_code_unique` ON `review_cycles` (`code`);--> statement-breakpoint
CREATE TABLE `review_feedback` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`review_id` text NOT NULL,
	`reviewee_id` text NOT NULL,
	`author_id` text NOT NULL,
	`comment` text,
	`overall_rating` integer,
	`state` text DEFAULT 'REQUESTED' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_feedback_code_unique` ON `review_feedback` (`code`);--> statement-breakpoint
CREATE INDEX `rf_review_idx` ON `review_feedback` (`review_id`);--> statement-breakpoint
CREATE INDEX `rf_author_idx` ON `review_feedback` (`author_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`cycle_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`state` text DEFAULT 'SELF' NOT NULL,
	`self_comment` text,
	`self_ratings_json` text,
	`ack_comment` text,
	`manager_comment` text,
	`overall_rating` integer,
	`ratings_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cycle_id`) REFERENCES `review_cycles`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_code_unique` ON `reviews` (`code`);--> statement-breakpoint
CREATE INDEX `rev_cycle_idx` ON `reviews` (`cycle_id`);--> statement-breakpoint
CREATE INDEX `rev_emp_idx` ON `reviews` (`employee_id`);--> statement-breakpoint
CREATE TABLE `roles` (
	`name` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `salary_structures` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`description` text,
	`lines_json` text DEFAULT '[]' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `salary_structures_code_unique` ON `salary_structures` (`code`);--> statement-breakpoint
CREATE TABLE `search_docs` (
	`collection` text NOT NULL,
	`record_id` text NOT NULL,
	`code` text,
	`owner_id` text,
	`title` text,
	`subtitle` text,
	`deleted` integer DEFAULT false NOT NULL,
	`restricted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_docs_record_idx` ON `search_docs` (`collection`,`record_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settlements` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`settlement_date` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`leave_days` real DEFAULT 0 NOT NULL,
	`notice_shortfall_days` real DEFAULT 0 NOT NULL,
	`lines_json` text NOT NULL,
	`total_earnings` real NOT NULL,
	`total_deductions` real NOT NULL,
	`net` real NOT NULL,
	`settled_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_code_unique` ON `settlements` (`code`);--> statement-breakpoint
CREATE INDEX `settle_emp_idx` ON `settlements` (`employee_id`);--> statement-breakpoint
CREATE TABLE `shift_assignments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`shift_id` text NOT NULL,
	`date` integer NOT NULL,
	`note` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shift_assignments_code_unique` ON `shift_assignments` (`code`);--> statement-breakpoint
CREATE INDEX `sa_emp_idx` ON `shift_assignments` (`employee_id`);--> statement-breakpoint
CREATE INDEX `sa_shift_idx` ON `shift_assignments` (`shift_id`);--> statement-breakpoint
CREATE INDEX `sa_date_idx` ON `shift_assignments` (`date`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`start_time` text DEFAULT '09:00' NOT NULL,
	`end_time` text DEFAULT '18:00' NOT NULL,
	`break_minutes` integer DEFAULT 0 NOT NULL,
	`color` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shifts_code_unique` ON `shifts` (`code`);--> statement-breakpoint
CREATE TABLE `sprints` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text,
	`start_date` integer,
	`end_date` integer,
	`state` text DEFAULT 'planning' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sprints_code_unique` ON `sprints` (`code`);--> statement-breakpoint
CREATE INDEX `sprint_board_idx` ON `sprints` (`board_id`);--> statement-breakpoint
CREATE TABLE `suggestion_votes` (
	`uuid` text PRIMARY KEY NOT NULL,
	`suggestion_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`value` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`suggestion_id`) REFERENCES `suggestions`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sugg_vote_uniq` ON `suggestion_votes` (`suggestion_id`,`employee_id`);--> statement-breakpoint
CREATE INDEX `sugg_vote_sugg_idx` ON `suggestion_votes` (`suggestion_id`);--> statement-breakpoint
CREATE TABLE `suggestions` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`submitter_id` text NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`category` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`response` text,
	`responded_by_id` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`submitter_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`responded_by_id`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suggestions_code_unique` ON `suggestions` (`code`);--> statement-breakpoint
CREATE INDEX `sugg_submitter_idx` ON `suggestions` (`submitter_id`);--> statement-breakpoint
CREATE INDEX `sugg_status_idx` ON `suggestions` (`status`);--> statement-breakpoint
CREATE TABLE `tax_declarations` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`financial_year` text NOT NULL,
	`section` text NOT NULL,
	`label` text,
	`declared_amount` real DEFAULT 0 NOT NULL,
	`verified_amount` real,
	`status` text DEFAULT 'DECLARED' NOT NULL,
	`note` text,
	`decided_by` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_declarations_code_unique` ON `tax_declarations` (`code`);--> statement-breakpoint
CREATE INDEX `td_emp_idx` ON `tax_declarations` (`employee_id`);--> statement-breakpoint
CREATE INDEX `td_fy_idx` ON `tax_declarations` (`financial_year`);--> statement-breakpoint
CREATE TABLE `ticket_checklists` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_checklists_code_unique` ON `ticket_checklists` (`code`);--> statement-breakpoint
CREATE TABLE `ticket_comments` (
	`uuid` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_id` text,
	`author_email` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tc_ticket_idx` ON `ticket_comments` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `ticket_todos` (
	`uuid` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tt_ticket_idx` ON `ticket_todos` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`category` text,
	`department_id` text,
	`assignee_id` text,
	`subject` text NOT NULL,
	`description` text,
	`priority` text DEFAULT 'medium' NOT NULL,
	`state` text DEFAULT 'OPEN' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_code_unique` ON `tickets` (`code`);--> statement-breakpoint
CREATE INDEX `ticket_emp_idx` ON `tickets` (`employee_id`);--> statement-breakpoint
CREATE INDEX `ticket_dept_idx` ON `tickets` (`department_id`);--> statement-breakpoint
CREATE INDEX `ticket_assignee_idx` ON `tickets` (`assignee_id`);--> statement-breakpoint
CREATE INDEX `ticket_state_idx` ON `tickets` (`state`);--> statement-breakpoint
CREATE TABLE `time_entries` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`project_id` text NOT NULL,
	`date` integer NOT NULL,
	`hours` real DEFAULT 0 NOT NULL,
	`description` text,
	`billable` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`decided_by` text,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `time_entries_code_unique` ON `time_entries` (`code`);--> statement-breakpoint
CREATE INDEX `te_emp_idx` ON `time_entries` (`employee_id`);--> statement-breakpoint
CREATE INDEX `te_proj_idx` ON `time_entries` (`project_id`);--> statement-breakpoint
CREATE INDEX `te_date_idx` ON `time_entries` (`date`);--> statement-breakpoint
CREATE TABLE `transition_tasks` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`transition_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`assignee_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`due_date` integer,
	`status` text DEFAULT 'TODO' NOT NULL,
	`note` text,
	`background_check_id` text,
	`doc_type` text,
	`document_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`transition_id`) REFERENCES `transitions`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`background_check_id`) REFERENCES `background_checks`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `personal_documents`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transition_tasks_code_unique` ON `transition_tasks` (`code`);--> statement-breakpoint
CREATE INDEX `trt_trn_idx` ON `transition_tasks` (`transition_id`);--> statement-breakpoint
CREATE INDEX `trt_assignee_idx` ON `transition_tasks` (`assignee_id`);--> statement-breakpoint
CREATE TABLE `transitions` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`employee_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`anchor_date` integer,
	`state` text DEFAULT 'ACTIVE' NOT NULL,
	`delete_time` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transitions_code_unique` ON `transitions` (`code`);--> statement-breakpoint
CREATE INDEX `trn_emp_idx` ON `transitions` (`employee_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`email` text NOT NULL,
	`role` text DEFAULT 'employee' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`employee_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`role`) REFERENCES `roles`(`name`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_code_unique` ON `users` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`contact_email` text,
	`contact_phone` text,
	`tax_id` text,
	`payment_terms` text,
	`bank_details` text,
	`default_category_id` text,
	`notes` text,
	`delete_time` integer,
	`disabled` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`locked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`default_category_id`) REFERENCES `expense_categories`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_code_unique` ON `vendors` (`code`);--> statement-breakpoint
CREATE TABLE `workflow_instances` (
	`uuid` text PRIMARY KEY NOT NULL,
	`code` text,
	`automation_id` text,
	`status` text DEFAULT 'waiting' NOT NULL,
	`awaited_types` text,
	`arms_json` text NOT NULL,
	`results_json` text,
	`origin_type` text,
	`subject` text,
	`employee_id` text,
	`correlation_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`resumed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`uuid`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_instances_code_unique` ON `workflow_instances` (`code`);--> statement-breakpoint
CREATE INDEX `workflow_instances_status_idx` ON `workflow_instances` (`status`);
--> statement-breakpoint
-- Global search index. GENERATED from src/domain/searchIndex.ts by scripts/genSearchDdl.ts - do not edit
-- by hand; run `npm run db:generate`. `prefix='2 3'` makes 2- and 3-character prefix queries index-backed,
-- which is what a search-as-you-type box issues; unicode61 folds capitalisation and diacritics.
CREATE VIRTUAL TABLE "search_fts" USING fts5("text", prefix='2 3', tokenize='unicode61');
--> statement-breakpoint
CREATE TRIGGER "search_ai_employees" AFTER INSERT ON "employees" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('employees', new."uuid", new."code", new."uuid", nullif(trim(coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '')), ''), coalesce(nullif(trim(new."job_title"), ''), nullif(trim(new."work_email"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '') || ' ' || coalesce(new."legal_name", '') || ' ' || coalesce(new."work_email", '') || ' ' || coalesce(new."job_title", '') || ' ' || coalesce(new."employee_number", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_employees" AFTER UPDATE ON "employees" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."uuid", "title" = nullif(trim(coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '')), ''), "subtitle" = coalesce(nullif(trim(new."job_title"), ''), nullif(trim(new."work_email"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'employees' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."first_name", '') || ' ' || coalesce(new."last_name", '') || ' ' || coalesce(new."legal_name", '') || ' ' || coalesce(new."work_email", '') || ' ' || coalesce(new."job_title", '') || ' ' || coalesce(new."employee_number", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'employees' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_employees" AFTER DELETE ON "employees" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'employees' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'employees' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_departments" AFTER INSERT ON "departments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('departments', new."uuid", new."code", new."code", nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_departments" AFTER UPDATE ON "departments" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'departments' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'departments' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_departments" AFTER DELETE ON "departments" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'departments' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'departments' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_positions" AFTER INSERT ON "positions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('positions', new."uuid", new."code", new."employee_id", nullif(trim(new."job_title"), ''), coalesce(nullif(trim(new."location"), ''), nullif(trim(new."note"), '')), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."job_title", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."note", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_positions" AFTER UPDATE ON "positions" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."job_title"), ''), "subtitle" = coalesce(nullif(trim(new."location"), ''), nullif(trim(new."note"), '')), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'positions' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."job_title", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."note", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'positions' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_positions" AFTER DELETE ON "positions" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'positions' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'positions' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_leave_requests" AFTER INSERT ON "leave_requests" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('leave-requests', new."uuid", new."code", new."employee_id", nullif(trim(new."reason"), ''), nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."reason", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_leave_requests" AFTER UPDATE ON "leave_requests" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'leave-requests' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."reason", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-requests' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_leave_requests" AFTER DELETE ON "leave_requests" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-requests' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'leave-requests' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_leave_encashments" AFTER INSERT ON "leave_encashments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('leave-encashments', new."uuid", new."code", new."employee_id", NULL, nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_leave_encashments" AFTER UPDATE ON "leave_encashments" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = NULL, "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'leave-encashments' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-encashments' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_leave_encashments" AFTER DELETE ON "leave_encashments" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-encashments' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'leave-encashments' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_leave_types" AFTER INSERT ON "leave_types" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('leave-types', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_leave_types" AFTER UPDATE ON "leave_types" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'leave-types' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-types' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_leave_types" AFTER DELETE ON "leave_types" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'leave-types' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'leave-types' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_holidays" AFTER INSERT ON "holidays" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('holidays', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."kind"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."kind", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_holidays" AFTER UPDATE ON "holidays" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'holidays' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."kind", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'holidays' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_holidays" AFTER DELETE ON "holidays" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'holidays' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'holidays' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_attendance" AFTER INSERT ON "attendance_sessions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('attendance', new."uuid", new."code", new."employee_id", nullif(trim(new."note"), ''), nullif(trim(new."source"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."note", '') || ' ' || coalesce(new."source", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_attendance" AFTER UPDATE ON "attendance_sessions" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."note"), ''), "subtitle" = nullif(trim(new."source"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'attendance' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."note", '') || ' ' || coalesce(new."source", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_attendance" AFTER DELETE ON "attendance_sessions" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'attendance' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_attendance_regularizations" AFTER INSERT ON "attendance_regularizations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('attendance-regularizations', new."uuid", new."code", new."employee_id", nullif(trim(new."reason"), ''), nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."reason", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_attendance_regularizations" AFTER UPDATE ON "attendance_regularizations" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'attendance-regularizations' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."reason", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance-regularizations' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_attendance_regularizations" AFTER DELETE ON "attendance_regularizations" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'attendance-regularizations' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'attendance-regularizations' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_overtime_requests" AFTER INSERT ON "overtime_requests" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('overtime-requests', new."uuid", new."code", new."employee_id", nullif(trim(new."reason"), ''), nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."reason", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."decision_note", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_overtime_requests" AFTER UPDATE ON "overtime_requests" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'overtime-requests' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."reason", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."decision_note", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'overtime-requests' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_overtime_requests" AFTER DELETE ON "overtime_requests" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'overtime-requests' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'overtime-requests' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_remote_work_requests" AFTER INSERT ON "remote_work_requests" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('remote-work-requests', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."location"), '')), coalesce(nullif(trim(new."location"), ''), nullif(trim(new."state"), '')), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."location", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_remote_work_requests" AFTER UPDATE ON "remote_work_requests" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."location"), '')), "subtitle" = coalesce(nullif(trim(new."location"), ''), nullif(trim(new."state"), '')), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'remote-work-requests' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."location", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'remote-work-requests' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_remote_work_requests" AFTER DELETE ON "remote_work_requests" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'remote-work-requests' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'remote-work-requests' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_approval_delegations" AFTER INSERT ON "approval_delegations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('approval-delegations', new."uuid", new."code", new."delegator_id", nullif(trim(new."reason"), ''), NULL, 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."reason", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_approval_delegations" AFTER UPDATE ON "approval_delegations" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."delegator_id", "title" = nullif(trim(new."reason"), ''), "subtitle" = NULL, "deleted" = 0, "restricted" = 0 WHERE "collection" = 'approval-delegations' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."reason", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'approval-delegations' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_approval_delegations" AFTER DELETE ON "approval_delegations" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'approval-delegations' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'approval-delegations' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_shifts" AFTER INSERT ON "shifts" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('shifts', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_shifts" AFTER UPDATE ON "shifts" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'shifts' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shifts' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_shifts" AFTER DELETE ON "shifts" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shifts' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'shifts' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_shift_assignments" AFTER INSERT ON "shift_assignments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('shift-assignments', new."uuid", new."code", new."employee_id", nullif(trim(new."note"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."note", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_shift_assignments" AFTER UPDATE ON "shift_assignments" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."note"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'shift-assignments' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."note", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_shift_assignments" AFTER DELETE ON "shift_assignments" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'shift-assignments' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_projects" AFTER INSERT ON "projects" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('projects', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), coalesce(nullif(trim(new."client"), ''), nullif(trim(new."project_code"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."client", '') || ' ' || coalesce(new."project_code", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_projects" AFTER UPDATE ON "projects" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."client"), ''), nullif(trim(new."project_code"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'projects' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."client", '') || ' ' || coalesce(new."project_code", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'projects' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_projects" AFTER DELETE ON "projects" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'projects' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'projects' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_time_entries" AFTER INSERT ON "time_entries" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('time-entries', new."uuid", new."code", new."employee_id", nullif(trim(new."description"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."description", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_time_entries" AFTER UPDATE ON "time_entries" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."description"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'time-entries' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."description", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'time-entries' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_time_entries" AFTER DELETE ON "time_entries" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'time-entries' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'time-entries' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_goals" AFTER INSERT ON "goals" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('goals', new."uuid", new."code", new."employee_id", nullif(trim(new."title"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_goals" AFTER UPDATE ON "goals" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'goals' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'goals' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_goals" AFTER DELETE ON "goals" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'goals' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'goals' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_boards" AFTER INSERT ON "boards" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('boards', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."description"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."task_prefix", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_boards" AFTER UPDATE ON "boards" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'boards' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."task_prefix", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'boards' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_boards" AFTER DELETE ON "boards" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'boards' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'boards' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_sprints" AFTER INSERT ON "sprints" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('sprints', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), coalesce(nullif(trim(new."goal"), ''), nullif(trim(new."state"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."goal", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_sprints" AFTER UPDATE ON "sprints" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."goal"), ''), nullif(trim(new."state"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'sprints' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."goal", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'sprints' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_sprints" AFTER DELETE ON "sprints" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'sprints' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'sprints' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_cards" AFTER INSERT ON "cards" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('cards', new."uuid", new."code", new."employee_id", nullif(trim(new."title"), ''), nullif(trim(new."column_key"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."key_prefix", '') || ' ' || coalesce(new."column_key", '') || ' ' || coalesce(new."priority", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_cards" AFTER UPDATE ON "cards" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."column_key"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'cards' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."key_prefix", '') || ' ' || coalesce(new."column_key", '') || ' ' || coalesce(new."priority", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'cards' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_cards" AFTER DELETE ON "cards" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'cards' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'cards' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_review_cycles" AFTER INSERT ON "review_cycles" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('review-cycles', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."state"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_review_cycles" AFTER UPDATE ON "review_cycles" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'review-cycles' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-cycles' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_review_cycles" AFTER DELETE ON "review_cycles" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-cycles' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'review-cycles' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_reviews" AFTER INSERT ON "reviews" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('reviews', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."self_comment"), ''), nullif(trim(new."manager_comment"), '')), nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."self_comment", '') || ' ' || coalesce(new."manager_comment", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_reviews" AFTER UPDATE ON "reviews" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."self_comment"), ''), nullif(trim(new."manager_comment"), '')), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'reviews' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."self_comment", '') || ' ' || coalesce(new."manager_comment", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reviews' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_reviews" AFTER DELETE ON "reviews" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reviews' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'reviews' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_review_feedback" AFTER INSERT ON "review_feedback" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('review-feedback', new."uuid", new."code", new."author_id", nullif(trim(new."comment"), ''), nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."comment", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_review_feedback" AFTER UPDATE ON "review_feedback" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."author_id", "title" = nullif(trim(new."comment"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'review-feedback' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."comment", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-feedback' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_review_feedback" AFTER DELETE ON "review_feedback" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'review-feedback' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'review-feedback' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_check_ins" AFTER INSERT ON "check_ins" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('check-ins', new."uuid", new."code", new."employee_id", nullif(trim(new."notes"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."notes", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_check_ins" AFTER UPDATE ON "check_ins" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."notes"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'check-ins' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."notes", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'check-ins' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_check_ins" AFTER DELETE ON "check_ins" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'check-ins' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'check-ins' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_transitions" AFTER INSERT ON "transitions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('transitions', new."uuid", new."code", new."employee_id", nullif(trim(new."name"), ''), coalesce(nullif(trim(new."kind"), ''), nullif(trim(new."state"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_transitions" AFTER UPDATE ON "transitions" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."kind"), ''), nullif(trim(new."state"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'transitions' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transitions' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_transitions" AFTER DELETE ON "transitions" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transitions' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'transitions' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_transition_tasks" AFTER INSERT ON "transition_tasks" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('transition-tasks', new."uuid", new."code", new."assignee_id", nullif(trim(new."title"), ''), nullif(trim(new."status"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_transition_tasks" AFTER UPDATE ON "transition_tasks" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."assignee_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'transition-tasks' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transition-tasks' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_transition_tasks" AFTER DELETE ON "transition_tasks" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'transition-tasks' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'transition-tasks' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_notice_periods" AFTER INSERT ON "notice_periods" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('notice-periods', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."type"), '')), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."type", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_notice_periods" AFTER UPDATE ON "notice_periods" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."type"), '')), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'notice-periods' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."type", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notice-periods' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_notice_periods" AFTER DELETE ON "notice_periods" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notice-periods' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'notice-periods' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_background_checks" AFTER INSERT ON "background_checks" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('background-checks', new."uuid", new."code", new."employee_id", nullif(trim(new."check_type"), ''), coalesce(nullif(trim(new."vendor"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."check_type", '') || ' ' || coalesce(new."vendor", '') || ' ' || coalesce(new."reference_no", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_background_checks" AFTER UPDATE ON "background_checks" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."check_type"), ''), "subtitle" = coalesce(nullif(trim(new."vendor"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'background-checks' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."check_type", '') || ' ' || coalesce(new."vendor", '') || ' ' || coalesce(new."reference_no", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'background-checks' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_background_checks" AFTER DELETE ON "background_checks" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'background-checks' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'background-checks' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_compliance_events" AFTER INSERT ON "compliance_events" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('compliance-events', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."category"), ''), nullif(trim(new."period_label"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."period_label", '') || ' ' || coalesce(new."reference", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_compliance_events" AFTER UPDATE ON "compliance_events" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."category"), ''), nullif(trim(new."period_label"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'compliance-events' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."period_label", '') || ' ' || coalesce(new."reference", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-events' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_compliance_events" AFTER DELETE ON "compliance_events" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-events' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'compliance-events' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_compliance_rules" AFTER INSERT ON "compliance_rules" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('compliance-rules', new."uuid", new."code", NULL, nullif(trim(new."title"), ''), nullif(trim(new."category"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."notes", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_compliance_rules" AFTER UPDATE ON "compliance_rules" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."category"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'compliance-rules' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."notes", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-rules' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_compliance_rules" AFTER DELETE ON "compliance_rules" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'compliance-rules' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'compliance-rules' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_org_documents" AFTER INSERT ON "org_documents" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('org-documents', new."uuid", new."code", new."code", coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), nullif(trim(new."document_type"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_org_documents" AFTER UPDATE ON "org_documents" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), "subtitle" = nullif(trim(new."document_type"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'org-documents' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'org-documents' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_org_documents" AFTER DELETE ON "org_documents" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'org-documents' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'org-documents' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_personal_documents" AFTER INSERT ON "personal_documents" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('personal-documents', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), nullif(trim(new."document_type"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", '') || ' ' || coalesce(new."financial_year", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_personal_documents" AFTER UPDATE ON "personal_documents" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."title"), ''), nullif(trim(new."file_name"), '')), "subtitle" = nullif(trim(new."document_type"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'personal-documents' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."file_name", '') || ' ' || coalesce(new."document_type", '') || ' ' || coalesce(new."financial_year", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'personal-documents' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_personal_documents" AFTER DELETE ON "personal_documents" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'personal-documents' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'personal-documents' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_letter_templates" AFTER INSERT ON "letter_templates" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('letter-templates', new."uuid", new."code", NULL, nullif(trim(new."label"), ''), nullif(trim(new."category"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."label", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."filename", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_letter_templates" AFTER UPDATE ON "letter_templates" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."label"), ''), "subtitle" = nullif(trim(new."category"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'letter-templates' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."label", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."filename", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'letter-templates' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_letter_templates" AFTER DELETE ON "letter_templates" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'letter-templates' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'letter-templates' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_announcements" AFTER INSERT ON "announcements" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('announcements', new."uuid", new."code", NULL, nullif(trim(new."title"), ''), nullif(trim(new."kind"), ''), (new."delete_time" IS NOT NULL), (coalesce(new."published", 0) <> 1 OR coalesce(new."disabled", 0) <> 0));
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."body_text", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."kind", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_announcements" AFTER UPDATE ON "announcements" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = (coalesce(new."published", 0) <> 1 OR coalesce(new."disabled", 0) <> 0) WHERE "collection" = 'announcements' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."body_text", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."kind", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'announcements' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_announcements" AFTER DELETE ON "announcements" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'announcements' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'announcements' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_events" AFTER INSERT ON "events" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('events', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), nullif(trim(new."description"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."description", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_events" AFTER UPDATE ON "events" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'events' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."description", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'events' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_events" AFTER DELETE ON "events" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'events' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'events' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_reimbursements" AFTER INSERT ON "reimbursements" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('reimbursements', new."uuid", new."code", new."employee_id", nullif(trim(new."description"), ''), nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."description", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_reimbursements" AFTER UPDATE ON "reimbursements" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."description"), ''), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'reimbursements' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."description", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursements' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_reimbursements" AFTER DELETE ON "reimbursements" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursements' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'reimbursements' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_reimbursement_categories" AFTER INSERT ON "reimbursement_categories" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('reimbursement-categories', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_reimbursement_categories" AFTER UPDATE ON "reimbursement_categories" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'reimbursement-categories' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursement-categories' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_reimbursement_categories" AFTER DELETE ON "reimbursement_categories" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'reimbursement-categories' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'reimbursement-categories' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_expenses" AFTER INSERT ON "expenses" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('expenses', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."description"), ''), nullif(trim(new."invoice_number"), '')), nullif(trim(new."state"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."description", '') || ' ' || coalesce(new."invoice_number", '') || ' ' || coalesce(new."payment_ref", '') || ' ' || coalesce(new."state", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_expenses" AFTER UPDATE ON "expenses" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."description"), ''), nullif(trim(new."invoice_number"), '')), "subtitle" = nullif(trim(new."state"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'expenses' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."description", '') || ' ' || coalesce(new."invoice_number", '') || ' ' || coalesce(new."payment_ref", '') || ' ' || coalesce(new."state", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expenses' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_expenses" AFTER DELETE ON "expenses" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expenses' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'expenses' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_expense_categories" AFTER INSERT ON "expense_categories" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('expense-categories', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."gl_code"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."gl_code", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_expense_categories" AFTER UPDATE ON "expense_categories" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."gl_code"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'expense-categories' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."gl_code", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-categories' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_expense_categories" AFTER DELETE ON "expense_categories" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-categories' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'expense-categories' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_expense_budgets" AFTER INSERT ON "expense_budgets" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('expense-budgets', new."uuid", new."code", NULL, nullif(trim(new."period_key"), ''), nullif(trim(new."period_type"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."period_key", '') || ' ' || coalesce(new."period_type", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_expense_budgets" AFTER UPDATE ON "expense_budgets" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."period_key"), ''), "subtitle" = nullif(trim(new."period_type"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'expense-budgets' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."period_key", '') || ' ' || coalesce(new."period_type", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-budgets' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_expense_budgets" AFTER DELETE ON "expense_budgets" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'expense-budgets' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'expense-budgets' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_vendors" AFTER INSERT ON "vendors" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('vendors', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."contact_email"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."contact_email", '') || ' ' || coalesce(new."tax_id", '') || ' ' || coalesce(new."notes", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_vendors" AFTER UPDATE ON "vendors" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."contact_email"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'vendors' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."contact_email", '') || ' ' || coalesce(new."tax_id", '') || ' ' || coalesce(new."notes", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'vendors' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_vendors" AFTER DELETE ON "vendors" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'vendors' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'vendors' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_loans" AFTER INSERT ON "loans" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('loans', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."kind", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_loans" AFTER UPDATE ON "loans" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'loans' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."kind", '') || ' ' || coalesce(new."reason", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'loans' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_loans" AFTER DELETE ON "loans" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'loans' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'loans' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_bonuses" AFTER INSERT ON "bonuses" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('bonuses', new."uuid", new."code", new."employee_id", coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), nullif(trim(new."kind"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."kind", '') || ' ' || coalesce(new."reason", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_bonuses" AFTER UPDATE ON "bonuses" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = coalesce(nullif(trim(new."reason"), ''), nullif(trim(new."kind"), '')), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'bonuses' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."kind", '') || ' ' || coalesce(new."reason", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'bonuses' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_bonuses" AFTER DELETE ON "bonuses" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'bonuses' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'bonuses' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_tax_declarations" AFTER INSERT ON "tax_declarations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('tax-declarations', new."uuid", new."code", new."employee_id", nullif(trim(new."label"), ''), coalesce(nullif(trim(new."section"), ''), nullif(trim(new."financial_year"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."label", '') || ' ' || coalesce(new."section", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."financial_year", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_tax_declarations" AFTER UPDATE ON "tax_declarations" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."label"), ''), "subtitle" = coalesce(nullif(trim(new."section"), ''), nullif(trim(new."financial_year"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'tax-declarations' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."label", '') || ' ' || coalesce(new."section", '') || ' ' || coalesce(new."note", '') || ' ' || coalesce(new."financial_year", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tax-declarations' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_tax_declarations" AFTER DELETE ON "tax_declarations" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tax-declarations' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'tax-declarations' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_pay_components" AFTER INSERT ON "pay_components" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('pay-components', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."kind"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."method", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_pay_components" AFTER UPDATE ON "pay_components" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."kind"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'pay-components' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."kind", '') || ' ' || coalesce(new."method", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-components' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_pay_components" AFTER DELETE ON "pay_components" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-components' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'pay-components' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_pay_grades" AFTER INSERT ON "pay_grades" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('pay-grades', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."level"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."level", '') || ' ' || coalesce(new."description", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_pay_grades" AFTER UPDATE ON "pay_grades" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."level"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'pay-grades' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."level", '') || ' ' || coalesce(new."description", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-grades' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_pay_grades" AFTER DELETE ON "pay_grades" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-grades' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'pay-grades' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_salary_structures" AFTER INSERT ON "salary_structures" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('salary-structures', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."description"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."description", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_salary_structures" AFTER UPDATE ON "salary_structures" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'salary-structures' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."description", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'salary-structures' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_salary_structures" AFTER DELETE ON "salary_structures" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'salary-structures' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'salary-structures' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_pay_periods" AFTER INSERT ON "pay_periods" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('pay-periods', new."uuid", new."code", NULL, nullif(trim(new."label"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."label", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_pay_periods" AFTER UPDATE ON "pay_periods" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."label"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'pay-periods' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."label", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-periods' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_pay_periods" AFTER DELETE ON "pay_periods" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'pay-periods' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'pay-periods' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_benefit_plans" AFTER INSERT ON "benefit_plans" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('benefit-plans', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), coalesce(nullif(trim(new."provider"), ''), nullif(trim(new."category"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."provider", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_benefit_plans" AFTER UPDATE ON "benefit_plans" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."provider"), ''), nullif(trim(new."category"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'benefit-plans' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."provider", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-plans' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_benefit_plans" AFTER DELETE ON "benefit_plans" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-plans' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'benefit-plans' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_dependents" AFTER INSERT ON "dependents" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('dependents', new."uuid", new."code", new."employee_id", nullif(trim(new."name"), ''), nullif(trim(new."relationship"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."relationship", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_dependents" AFTER UPDATE ON "dependents" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."relationship"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'dependents' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."relationship", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'dependents' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_dependents" AFTER DELETE ON "dependents" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'dependents' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'dependents' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_benefit_enrollments" AFTER INSERT ON "benefit_enrollments" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('benefit-enrollments', new."uuid", new."code", new."employee_id", NULL, nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_benefit_enrollments" AFTER UPDATE ON "benefit_enrollments" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = NULL, "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'benefit-enrollments' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-enrollments' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_benefit_enrollments" AFTER DELETE ON "benefit_enrollments" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'benefit-enrollments' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'benefit-enrollments' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_job_requisitions" AFTER INSERT ON "job_requisitions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('job-requisitions', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."location"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."employment_type", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_job_requisitions" AFTER UPDATE ON "job_requisitions" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."location"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'job-requisitions' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."employment_type", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'job-requisitions' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_job_requisitions" AFTER DELETE ON "job_requisitions" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'job-requisitions' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'job-requisitions' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_candidates" AFTER INSERT ON "candidates" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('candidates', new."uuid", new."code", new."code", nullif(trim(new."name"), ''), coalesce(nullif(trim(new."email"), ''), nullif(trim(new."source"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."email", '') || ' ' || coalesce(new."phone", '') || ' ' || coalesce(new."source", '') || ' ' || coalesce(new."tags", '') || ' ' || coalesce(new."notes", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_candidates" AFTER UPDATE ON "candidates" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."email"), ''), nullif(trim(new."source"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'candidates' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."email", '') || ' ' || coalesce(new."phone", '') || ' ' || coalesce(new."source", '') || ' ' || coalesce(new."tags", '') || ' ' || coalesce(new."notes", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'candidates' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_candidates" AFTER DELETE ON "candidates" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'candidates' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'candidates' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_applications" AFTER INSERT ON "applications" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('applications', new."uuid", new."code", new."code", nullif(trim(new."stage"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."stage", '') || ' ' || coalesce(new."status", '') || ' ' || coalesce(new."rejection_reason", '') || ' ' || coalesce(new."source", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_applications" AFTER UPDATE ON "applications" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."stage"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'applications' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."stage", '') || ' ' || coalesce(new."status", '') || ' ' || coalesce(new."rejection_reason", '') || ' ' || coalesce(new."source", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'applications' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_applications" AFTER DELETE ON "applications" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'applications' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'applications' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_interviews" AFTER INSERT ON "interviews" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('interviews', new."uuid", new."code", new."code", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."mode"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."mode", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_interviews" AFTER UPDATE ON "interviews" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."mode"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'interviews' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."mode", '') || ' ' || coalesce(new."location", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interviews' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_interviews" AFTER DELETE ON "interviews" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interviews' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'interviews' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_interview_feedback" AFTER INSERT ON "interview_feedback" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('interview-feedback', new."uuid", new."code", new."author_id", nullif(trim(new."comment"), ''), nullif(trim(new."recommendation"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."comment", '') || ' ' || coalesce(new."recommendation", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_interview_feedback" AFTER UPDATE ON "interview_feedback" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."author_id", "title" = nullif(trim(new."comment"), ''), "subtitle" = nullif(trim(new."recommendation"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'interview-feedback' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."comment", '') || ' ' || coalesce(new."recommendation", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interview-feedback' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_interview_feedback" AFTER DELETE ON "interview_feedback" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'interview-feedback' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'interview-feedback' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_offers" AFTER INSERT ON "offers" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('offers', new."uuid", new."code", new."code", nullif(trim(new."notes"), ''), nullif(trim(new."status"), ''), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."status", '') || ' ' || coalesce(new."notes", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_offers" AFTER UPDATE ON "offers" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."code", "title" = nullif(trim(new."notes"), ''), "subtitle" = nullif(trim(new."status"), ''), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'offers' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."status", '') || ' ' || coalesce(new."notes", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'offers' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_offers" AFTER DELETE ON "offers" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'offers' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'offers' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_referrals" AFTER INSERT ON "referrals" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('referrals', new."uuid", new."code", new."referrer_id", nullif(trim(new."candidate_name"), ''), coalesce(nullif(trim(new."position_title"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."candidate_name", '') || ' ' || coalesce(new."candidate_email", '') || ' ' || coalesce(new."position_title", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_referrals" AFTER UPDATE ON "referrals" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."referrer_id", "title" = nullif(trim(new."candidate_name"), ''), "subtitle" = coalesce(nullif(trim(new."position_title"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'referrals' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."candidate_name", '') || ' ' || coalesce(new."candidate_email", '') || ' ' || coalesce(new."position_title", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'referrals' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_referrals" AFTER DELETE ON "referrals" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'referrals' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'referrals' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_tickets" AFTER INSERT ON "tickets" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('tickets', new."uuid", new."code", new."employee_id", nullif(trim(new."subject"), ''), coalesce(nullif(trim(new."category"), ''), nullif(trim(new."state"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."subject", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."priority", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_tickets" AFTER UPDATE ON "tickets" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."employee_id", "title" = nullif(trim(new."subject"), ''), "subtitle" = coalesce(nullif(trim(new."category"), ''), nullif(trim(new."state"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'tickets' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."subject", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."state", '') || ' ' || coalesce(new."priority", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tickets' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_tickets" AFTER DELETE ON "tickets" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'tickets' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'tickets' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_ticket_checklists" AFTER INSERT ON "ticket_checklists" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('ticket-checklists', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), NULL, (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_ticket_checklists" AFTER UPDATE ON "ticket_checklists" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = NULL, "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'ticket-checklists' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'ticket-checklists' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_ticket_checklists" AFTER DELETE ON "ticket_checklists" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'ticket-checklists' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'ticket-checklists' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_suggestions" AFTER INSERT ON "suggestions" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('suggestions', new."uuid", new."code", new."submitter_id", nullif(trim(new."title"), ''), coalesce(nullif(trim(new."category"), ''), nullif(trim(new."status"), '')), (new."delete_time" IS NOT NULL), 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."response", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_suggestions" AFTER UPDATE ON "suggestions" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."submitter_id", "title" = nullif(trim(new."title"), ''), "subtitle" = coalesce(nullif(trim(new."category"), ''), nullif(trim(new."status"), '')), "deleted" = (new."delete_time" IS NOT NULL), "restricted" = 0 WHERE "collection" = 'suggestions' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."response", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'suggestions' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_suggestions" AFTER DELETE ON "suggestions" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'suggestions' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'suggestions' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_assets" AFTER INSERT ON "assets" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('assets', new."uuid", new."code", new."assigned_to", nullif(trim(new."name"), ''), coalesce(nullif(trim(new."asset_tag"), ''), nullif(trim(new."status"), '')), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."asset_tag", '') || ' ' || coalesce(new."serial_number", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_assets" AFTER UPDATE ON "assets" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."assigned_to", "title" = nullif(trim(new."name"), ''), "subtitle" = coalesce(nullif(trim(new."asset_tag"), ''), nullif(trim(new."status"), '')), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'assets' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."asset_tag", '') || ' ' || coalesce(new."serial_number", '') || ' ' || coalesce(new."category", '') || ' ' || coalesce(new."notes", '') || ' ' || coalesce(new."status", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'assets' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_assets" AFTER DELETE ON "assets" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'assets' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'assets' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_notifications" AFTER INSERT ON "notifications" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('notifications', new."uuid", new."code", new."recipient_id", nullif(trim(new."title"), ''), nullif(trim(new."body"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."type", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_notifications" AFTER UPDATE ON "notifications" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = new."recipient_id", "title" = nullif(trim(new."title"), ''), "subtitle" = nullif(trim(new."body"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'notifications' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."title", '') || ' ' || coalesce(new."body", '') || ' ' || coalesce(new."type", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notifications' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_notifications" AFTER DELETE ON "notifications" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'notifications' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'notifications' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
CREATE TRIGGER "search_ai_automations" AFTER INSERT ON "automations" BEGIN
  INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) VALUES ('automations', new."uuid", new."code", NULL, nullif(trim(new."name"), ''), nullif(trim(new."description"), ''), 0, 0);
  INSERT INTO "search_fts" ("rowid", "text") VALUES (last_insert_rowid(), coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."trigger_type", ''));
END;
--> statement-breakpoint
CREATE TRIGGER "search_au_automations" AFTER UPDATE ON "automations" BEGIN
  UPDATE "search_docs" SET "code" = new."code", "owner_id" = NULL, "title" = nullif(trim(new."name"), ''), "subtitle" = nullif(trim(new."description"), ''), "deleted" = 0, "restricted" = 0 WHERE "collection" = 'automations' AND "record_id" = new."uuid";
  UPDATE "search_fts" SET "text" = coalesce(new."name", '') || ' ' || coalesce(new."description", '') || ' ' || coalesce(new."trigger_type", '') WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'automations' AND "record_id" = new."uuid");
END;
--> statement-breakpoint
CREATE TRIGGER "search_ad_automations" AFTER DELETE ON "automations" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (SELECT "rowid" FROM "search_docs" WHERE "collection" = 'automations' AND "record_id" = old."uuid");
  DELETE FROM "search_docs" WHERE "collection" = 'automations' AND "record_id" = old."uuid";
END;
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'employees', t."uuid", t."code", t."uuid", nullif(trim(coalesce(t."first_name", '') || ' ' || coalesce(t."last_name", '')), ''), coalesce(nullif(trim(t."job_title"), ''), nullif(trim(t."work_email"), '')), (t."delete_time" IS NOT NULL), 0 FROM "employees" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."first_name", '') || ' ' || coalesce(t."last_name", '') || ' ' || coalesce(t."legal_name", '') || ' ' || coalesce(t."work_email", '') || ' ' || coalesce(t."job_title", '') || ' ' || coalesce(t."employee_number", '') FROM "search_docs" d JOIN "employees" t ON t."uuid" = d."record_id" WHERE d."collection" = 'employees' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'departments', t."uuid", t."code", t."code", nullif(trim(t."name"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "departments" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') FROM "search_docs" d JOIN "departments" t ON t."uuid" = d."record_id" WHERE d."collection" = 'departments' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'positions', t."uuid", t."code", t."employee_id", nullif(trim(t."job_title"), ''), coalesce(nullif(trim(t."location"), ''), nullif(trim(t."note"), '')), 0, 0 FROM "positions" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."job_title", '') || ' ' || coalesce(t."location", '') || ' ' || coalesce(t."note", '') FROM "search_docs" d JOIN "positions" t ON t."uuid" = d."record_id" WHERE d."collection" = 'positions' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'leave-requests', t."uuid", t."code", t."employee_id", nullif(trim(t."reason"), ''), nullif(trim(t."state"), ''), 0, 0 FROM "leave_requests" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."reason", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "leave_requests" t ON t."uuid" = d."record_id" WHERE d."collection" = 'leave-requests' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'leave-encashments', t."uuid", t."code", t."employee_id", NULL, nullif(trim(t."state"), ''), 0, 0 FROM "leave_encashments" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."state", '') FROM "search_docs" d JOIN "leave_encashments" t ON t."uuid" = d."record_id" WHERE d."collection" = 'leave-encashments' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'leave-types', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "leave_types" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') FROM "search_docs" d JOIN "leave_types" t ON t."uuid" = d."record_id" WHERE d."collection" = 'leave-types' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'holidays', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."kind"), ''), (t."delete_time" IS NOT NULL), 0 FROM "holidays" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."kind", '') FROM "search_docs" d JOIN "holidays" t ON t."uuid" = d."record_id" WHERE d."collection" = 'holidays' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'attendance', t."uuid", t."code", t."employee_id", nullif(trim(t."note"), ''), nullif(trim(t."source"), ''), 0, 0 FROM "attendance_sessions" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."note", '') || ' ' || coalesce(t."source", '') FROM "search_docs" d JOIN "attendance_sessions" t ON t."uuid" = d."record_id" WHERE d."collection" = 'attendance' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'attendance-regularizations', t."uuid", t."code", t."employee_id", nullif(trim(t."reason"), ''), nullif(trim(t."state"), ''), 0, 0 FROM "attendance_regularizations" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."reason", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "attendance_regularizations" t ON t."uuid" = d."record_id" WHERE d."collection" = 'attendance-regularizations' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'overtime-requests', t."uuid", t."code", t."employee_id", nullif(trim(t."reason"), ''), nullif(trim(t."state"), ''), 0, 0 FROM "overtime_requests" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."reason", '') || ' ' || coalesce(t."state", '') || ' ' || coalesce(t."decision_note", '') FROM "search_docs" d JOIN "overtime_requests" t ON t."uuid" = d."record_id" WHERE d."collection" = 'overtime-requests' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'remote-work-requests', t."uuid", t."code", t."employee_id", coalesce(nullif(trim(t."reason"), ''), nullif(trim(t."location"), '')), coalesce(nullif(trim(t."location"), ''), nullif(trim(t."state"), '')), 0, 0 FROM "remote_work_requests" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."location", '') || ' ' || coalesce(t."reason", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "remote_work_requests" t ON t."uuid" = d."record_id" WHERE d."collection" = 'remote-work-requests' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'approval-delegations', t."uuid", t."code", t."delegator_id", nullif(trim(t."reason"), ''), NULL, 0, 0 FROM "approval_delegations" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."reason", '') FROM "search_docs" d JOIN "approval_delegations" t ON t."uuid" = d."record_id" WHERE d."collection" = 'approval-delegations' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'shifts', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "shifts" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') FROM "search_docs" d JOIN "shifts" t ON t."uuid" = d."record_id" WHERE d."collection" = 'shifts' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'shift-assignments', t."uuid", t."code", t."employee_id", nullif(trim(t."note"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "shift_assignments" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."note", '') FROM "search_docs" d JOIN "shift_assignments" t ON t."uuid" = d."record_id" WHERE d."collection" = 'shift-assignments' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'projects', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), coalesce(nullif(trim(t."client"), ''), nullif(trim(t."project_code"), '')), (t."delete_time" IS NOT NULL), 0 FROM "projects" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."client", '') || ' ' || coalesce(t."project_code", '') FROM "search_docs" d JOIN "projects" t ON t."uuid" = d."record_id" WHERE d."collection" = 'projects' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'time-entries', t."uuid", t."code", t."employee_id", nullif(trim(t."description"), ''), nullif(trim(t."status"), ''), (t."delete_time" IS NOT NULL), 0 FROM "time_entries" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."description", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "time_entries" t ON t."uuid" = d."record_id" WHERE d."collection" = 'time-entries' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'goals', t."uuid", t."code", t."employee_id", nullif(trim(t."title"), ''), nullif(trim(t."status"), ''), (t."delete_time" IS NOT NULL), 0 FROM "goals" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "goals" t ON t."uuid" = d."record_id" WHERE d."collection" = 'goals' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'boards', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."description"), ''), (t."delete_time" IS NOT NULL), 0 FROM "boards" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."task_prefix", '') FROM "search_docs" d JOIN "boards" t ON t."uuid" = d."record_id" WHERE d."collection" = 'boards' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'sprints', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), coalesce(nullif(trim(t."goal"), ''), nullif(trim(t."state"), '')), (t."delete_time" IS NOT NULL), 0 FROM "sprints" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."goal", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "sprints" t ON t."uuid" = d."record_id" WHERE d."collection" = 'sprints' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'cards', t."uuid", t."code", t."employee_id", nullif(trim(t."title"), ''), nullif(trim(t."column_key"), ''), (t."delete_time" IS NOT NULL), 0 FROM "cards" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."key_prefix", '') || ' ' || coalesce(t."column_key", '') || ' ' || coalesce(t."priority", '') FROM "search_docs" d JOIN "cards" t ON t."uuid" = d."record_id" WHERE d."collection" = 'cards' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'review-cycles', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."state"), ''), (t."delete_time" IS NOT NULL), 0 FROM "review_cycles" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "review_cycles" t ON t."uuid" = d."record_id" WHERE d."collection" = 'review-cycles' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'reviews', t."uuid", t."code", t."employee_id", coalesce(nullif(trim(t."self_comment"), ''), nullif(trim(t."manager_comment"), '')), nullif(trim(t."state"), ''), 0, 0 FROM "reviews" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."self_comment", '') || ' ' || coalesce(t."manager_comment", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "reviews" t ON t."uuid" = d."record_id" WHERE d."collection" = 'reviews' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'review-feedback', t."uuid", t."code", t."author_id", nullif(trim(t."comment"), ''), nullif(trim(t."state"), ''), 0, 0 FROM "review_feedback" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."comment", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "review_feedback" t ON t."uuid" = d."record_id" WHERE d."collection" = 'review-feedback' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'check-ins', t."uuid", t."code", t."employee_id", nullif(trim(t."notes"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "check_ins" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."notes", '') FROM "search_docs" d JOIN "check_ins" t ON t."uuid" = d."record_id" WHERE d."collection" = 'check-ins' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'transitions', t."uuid", t."code", t."employee_id", nullif(trim(t."name"), ''), coalesce(nullif(trim(t."kind"), ''), nullif(trim(t."state"), '')), (t."delete_time" IS NOT NULL), 0 FROM "transitions" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."kind", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "transitions" t ON t."uuid" = d."record_id" WHERE d."collection" = 'transitions' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'transition-tasks', t."uuid", t."code", t."assignee_id", nullif(trim(t."title"), ''), nullif(trim(t."status"), ''), 0, 0 FROM "transition_tasks" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."note", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "transition_tasks" t ON t."uuid" = d."record_id" WHERE d."collection" = 'transition-tasks' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'notice-periods', t."uuid", t."code", t."employee_id", coalesce(nullif(trim(t."reason"), ''), nullif(trim(t."type"), '')), nullif(trim(t."status"), ''), (t."delete_time" IS NOT NULL), 0 FROM "notice_periods" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."type", '') || ' ' || coalesce(t."reason", '') || ' ' || coalesce(t."notes", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "notice_periods" t ON t."uuid" = d."record_id" WHERE d."collection" = 'notice-periods' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'background-checks', t."uuid", t."code", t."employee_id", nullif(trim(t."check_type"), ''), coalesce(nullif(trim(t."vendor"), ''), nullif(trim(t."status"), '')), (t."delete_time" IS NOT NULL), 0 FROM "background_checks" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."check_type", '') || ' ' || coalesce(t."vendor", '') || ' ' || coalesce(t."reference_no", '') || ' ' || coalesce(t."notes", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "background_checks" t ON t."uuid" = d."record_id" WHERE d."collection" = 'background-checks' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'compliance-events', t."uuid", t."code", t."code", nullif(trim(t."title"), ''), coalesce(nullif(trim(t."category"), ''), nullif(trim(t."period_label"), '')), (t."delete_time" IS NOT NULL), 0 FROM "compliance_events" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."period_label", '') || ' ' || coalesce(t."reference", '') || ' ' || coalesce(t."notes", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "compliance_events" t ON t."uuid" = d."record_id" WHERE d."collection" = 'compliance-events' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'compliance-rules', t."uuid", t."code", NULL, nullif(trim(t."title"), ''), nullif(trim(t."category"), ''), (t."delete_time" IS NOT NULL), 0 FROM "compliance_rules" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."notes", '') FROM "search_docs" d JOIN "compliance_rules" t ON t."uuid" = d."record_id" WHERE d."collection" = 'compliance-rules' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'org-documents', t."uuid", t."code", t."code", coalesce(nullif(trim(t."title"), ''), nullif(trim(t."file_name"), '')), nullif(trim(t."document_type"), ''), (t."delete_time" IS NOT NULL), 0 FROM "org_documents" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."file_name", '') || ' ' || coalesce(t."document_type", '') FROM "search_docs" d JOIN "org_documents" t ON t."uuid" = d."record_id" WHERE d."collection" = 'org-documents' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'personal-documents', t."uuid", t."code", t."employee_id", coalesce(nullif(trim(t."title"), ''), nullif(trim(t."file_name"), '')), nullif(trim(t."document_type"), ''), (t."delete_time" IS NOT NULL), 0 FROM "personal_documents" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."file_name", '') || ' ' || coalesce(t."document_type", '') || ' ' || coalesce(t."financial_year", '') FROM "search_docs" d JOIN "personal_documents" t ON t."uuid" = d."record_id" WHERE d."collection" = 'personal-documents' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'letter-templates', t."uuid", t."code", NULL, nullif(trim(t."label"), ''), nullif(trim(t."category"), ''), (t."delete_time" IS NOT NULL), 0 FROM "letter_templates" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."label", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."filename", '') FROM "search_docs" d JOIN "letter_templates" t ON t."uuid" = d."record_id" WHERE d."collection" = 'letter-templates' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'announcements', t."uuid", t."code", NULL, nullif(trim(t."title"), ''), nullif(trim(t."kind"), ''), (t."delete_time" IS NOT NULL), (coalesce(t."published", 0) <> 1 OR coalesce(t."disabled", 0) <> 0) FROM "announcements" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."body_text", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."kind", '') FROM "search_docs" d JOIN "announcements" t ON t."uuid" = d."record_id" WHERE d."collection" = 'announcements' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'events', t."uuid", t."code", t."code", nullif(trim(t."title"), ''), nullif(trim(t."description"), ''), (t."delete_time" IS NOT NULL), 0 FROM "events" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."description", '') FROM "search_docs" d JOIN "events" t ON t."uuid" = d."record_id" WHERE d."collection" = 'events' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'reimbursements', t."uuid", t."code", t."employee_id", nullif(trim(t."description"), ''), nullif(trim(t."state"), ''), 0, 0 FROM "reimbursements" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."description", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "reimbursements" t ON t."uuid" = d."record_id" WHERE d."collection" = 'reimbursements' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'reimbursement-categories', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "reimbursement_categories" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') FROM "search_docs" d JOIN "reimbursement_categories" t ON t."uuid" = d."record_id" WHERE d."collection" = 'reimbursement-categories' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'expenses', t."uuid", t."code", t."employee_id", coalesce(nullif(trim(t."description"), ''), nullif(trim(t."invoice_number"), '')), nullif(trim(t."state"), ''), 0, 0 FROM "expenses" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."description", '') || ' ' || coalesce(t."invoice_number", '') || ' ' || coalesce(t."payment_ref", '') || ' ' || coalesce(t."state", '') FROM "search_docs" d JOIN "expenses" t ON t."uuid" = d."record_id" WHERE d."collection" = 'expenses' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'expense-categories', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."gl_code"), ''), (t."delete_time" IS NOT NULL), 0 FROM "expense_categories" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."gl_code", '') FROM "search_docs" d JOIN "expense_categories" t ON t."uuid" = d."record_id" WHERE d."collection" = 'expense-categories' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'expense-budgets', t."uuid", t."code", NULL, nullif(trim(t."period_key"), ''), nullif(trim(t."period_type"), ''), (t."delete_time" IS NOT NULL), 0 FROM "expense_budgets" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."period_key", '') || ' ' || coalesce(t."period_type", '') FROM "search_docs" d JOIN "expense_budgets" t ON t."uuid" = d."record_id" WHERE d."collection" = 'expense-budgets' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'vendors', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."contact_email"), ''), (t."delete_time" IS NOT NULL), 0 FROM "vendors" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."contact_email", '') || ' ' || coalesce(t."tax_id", '') || ' ' || coalesce(t."notes", '') FROM "search_docs" d JOIN "vendors" t ON t."uuid" = d."record_id" WHERE d."collection" = 'vendors' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'loans', t."uuid", t."code", t."employee_id", coalesce(nullif(trim(t."reason"), ''), nullif(trim(t."kind"), '')), nullif(trim(t."status"), ''), (t."delete_time" IS NOT NULL), 0 FROM "loans" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."kind", '') || ' ' || coalesce(t."reason", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "loans" t ON t."uuid" = d."record_id" WHERE d."collection" = 'loans' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'bonuses', t."uuid", t."code", t."employee_id", coalesce(nullif(trim(t."reason"), ''), nullif(trim(t."kind"), '')), nullif(trim(t."kind"), ''), 0, 0 FROM "bonuses" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."kind", '') || ' ' || coalesce(t."reason", '') FROM "search_docs" d JOIN "bonuses" t ON t."uuid" = d."record_id" WHERE d."collection" = 'bonuses' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'tax-declarations', t."uuid", t."code", t."employee_id", nullif(trim(t."label"), ''), coalesce(nullif(trim(t."section"), ''), nullif(trim(t."financial_year"), '')), (t."delete_time" IS NOT NULL), 0 FROM "tax_declarations" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."label", '') || ' ' || coalesce(t."section", '') || ' ' || coalesce(t."note", '') || ' ' || coalesce(t."financial_year", '') FROM "search_docs" d JOIN "tax_declarations" t ON t."uuid" = d."record_id" WHERE d."collection" = 'tax-declarations' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'pay-components', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."kind"), ''), (t."delete_time" IS NOT NULL), 0 FROM "pay_components" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."kind", '') || ' ' || coalesce(t."method", '') FROM "search_docs" d JOIN "pay_components" t ON t."uuid" = d."record_id" WHERE d."collection" = 'pay-components' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'pay-grades', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."level"), ''), (t."delete_time" IS NOT NULL), 0 FROM "pay_grades" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."level", '') || ' ' || coalesce(t."description", '') FROM "search_docs" d JOIN "pay_grades" t ON t."uuid" = d."record_id" WHERE d."collection" = 'pay-grades' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'salary-structures', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."description"), ''), (t."delete_time" IS NOT NULL), 0 FROM "salary_structures" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."description", '') FROM "search_docs" d JOIN "salary_structures" t ON t."uuid" = d."record_id" WHERE d."collection" = 'salary-structures' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'pay-periods', t."uuid", t."code", NULL, nullif(trim(t."label"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "pay_periods" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."label", '') FROM "search_docs" d JOIN "pay_periods" t ON t."uuid" = d."record_id" WHERE d."collection" = 'pay-periods' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'benefit-plans', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), coalesce(nullif(trim(t."provider"), ''), nullif(trim(t."category"), '')), (t."delete_time" IS NOT NULL), 0 FROM "benefit_plans" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."provider", '') FROM "search_docs" d JOIN "benefit_plans" t ON t."uuid" = d."record_id" WHERE d."collection" = 'benefit-plans' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'dependents', t."uuid", t."code", t."employee_id", nullif(trim(t."name"), ''), nullif(trim(t."relationship"), ''), (t."delete_time" IS NOT NULL), 0 FROM "dependents" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."relationship", '') FROM "search_docs" d JOIN "dependents" t ON t."uuid" = d."record_id" WHERE d."collection" = 'dependents' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'benefit-enrollments', t."uuid", t."code", t."employee_id", NULL, nullif(trim(t."status"), ''), (t."delete_time" IS NOT NULL), 0 FROM "benefit_enrollments" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."status", '') FROM "search_docs" d JOIN "benefit_enrollments" t ON t."uuid" = d."record_id" WHERE d."collection" = 'benefit-enrollments' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'job-requisitions', t."uuid", t."code", t."code", nullif(trim(t."title"), ''), coalesce(nullif(trim(t."location"), ''), nullif(trim(t."status"), '')), (t."delete_time" IS NOT NULL), 0 FROM "job_requisitions" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."location", '') || ' ' || coalesce(t."employment_type", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "job_requisitions" t ON t."uuid" = d."record_id" WHERE d."collection" = 'job-requisitions' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'candidates', t."uuid", t."code", t."code", nullif(trim(t."name"), ''), coalesce(nullif(trim(t."email"), ''), nullif(trim(t."source"), '')), (t."delete_time" IS NOT NULL), 0 FROM "candidates" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."email", '') || ' ' || coalesce(t."phone", '') || ' ' || coalesce(t."source", '') || ' ' || coalesce(t."tags", '') || ' ' || coalesce(t."notes", '') FROM "search_docs" d JOIN "candidates" t ON t."uuid" = d."record_id" WHERE d."collection" = 'candidates' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'applications', t."uuid", t."code", t."code", nullif(trim(t."stage"), ''), nullif(trim(t."status"), ''), (t."delete_time" IS NOT NULL), 0 FROM "applications" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."stage", '') || ' ' || coalesce(t."status", '') || ' ' || coalesce(t."rejection_reason", '') || ' ' || coalesce(t."source", '') FROM "search_docs" d JOIN "applications" t ON t."uuid" = d."record_id" WHERE d."collection" = 'applications' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'interviews', t."uuid", t."code", t."code", nullif(trim(t."title"), ''), coalesce(nullif(trim(t."mode"), ''), nullif(trim(t."status"), '')), (t."delete_time" IS NOT NULL), 0 FROM "interviews" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."mode", '') || ' ' || coalesce(t."location", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "interviews" t ON t."uuid" = d."record_id" WHERE d."collection" = 'interviews' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'interview-feedback', t."uuid", t."code", t."author_id", nullif(trim(t."comment"), ''), nullif(trim(t."recommendation"), ''), (t."delete_time" IS NOT NULL), 0 FROM "interview_feedback" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."comment", '') || ' ' || coalesce(t."recommendation", '') FROM "search_docs" d JOIN "interview_feedback" t ON t."uuid" = d."record_id" WHERE d."collection" = 'interview-feedback' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'offers', t."uuid", t."code", t."code", nullif(trim(t."notes"), ''), nullif(trim(t."status"), ''), (t."delete_time" IS NOT NULL), 0 FROM "offers" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."status", '') || ' ' || coalesce(t."notes", '') FROM "search_docs" d JOIN "offers" t ON t."uuid" = d."record_id" WHERE d."collection" = 'offers' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'referrals', t."uuid", t."code", t."referrer_id", nullif(trim(t."candidate_name"), ''), coalesce(nullif(trim(t."position_title"), ''), nullif(trim(t."status"), '')), (t."delete_time" IS NOT NULL), 0 FROM "referrals" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."candidate_name", '') || ' ' || coalesce(t."candidate_email", '') || ' ' || coalesce(t."position_title", '') || ' ' || coalesce(t."notes", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "referrals" t ON t."uuid" = d."record_id" WHERE d."collection" = 'referrals' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'tickets', t."uuid", t."code", t."employee_id", nullif(trim(t."subject"), ''), coalesce(nullif(trim(t."category"), ''), nullif(trim(t."state"), '')), (t."delete_time" IS NOT NULL), 0 FROM "tickets" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."subject", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."state", '') || ' ' || coalesce(t."priority", '') FROM "search_docs" d JOIN "tickets" t ON t."uuid" = d."record_id" WHERE d."collection" = 'tickets' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'ticket-checklists', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), NULL, (t."delete_time" IS NOT NULL), 0 FROM "ticket_checklists" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') FROM "search_docs" d JOIN "ticket_checklists" t ON t."uuid" = d."record_id" WHERE d."collection" = 'ticket-checklists' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'suggestions', t."uuid", t."code", t."submitter_id", nullif(trim(t."title"), ''), coalesce(nullif(trim(t."category"), ''), nullif(trim(t."status"), '')), (t."delete_time" IS NOT NULL), 0 FROM "suggestions" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."body", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."response", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "suggestions" t ON t."uuid" = d."record_id" WHERE d."collection" = 'suggestions' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'assets', t."uuid", t."code", t."assigned_to", nullif(trim(t."name"), ''), coalesce(nullif(trim(t."asset_tag"), ''), nullif(trim(t."status"), '')), 0, 0 FROM "assets" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."asset_tag", '') || ' ' || coalesce(t."serial_number", '') || ' ' || coalesce(t."category", '') || ' ' || coalesce(t."notes", '') || ' ' || coalesce(t."status", '') FROM "search_docs" d JOIN "assets" t ON t."uuid" = d."record_id" WHERE d."collection" = 'assets' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'notifications', t."uuid", t."code", t."recipient_id", nullif(trim(t."title"), ''), nullif(trim(t."body"), ''), 0, 0 FROM "notifications" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."title", '') || ' ' || coalesce(t."body", '') || ' ' || coalesce(t."type", '') FROM "search_docs" d JOIN "notifications" t ON t."uuid" = d."record_id" WHERE d."collection" = 'notifications' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
--> statement-breakpoint
INSERT INTO "search_docs" (collection, record_id, code, owner_id, title, subtitle, deleted, restricted) SELECT 'automations', t."uuid", t."code", NULL, nullif(trim(t."name"), ''), nullif(trim(t."description"), ''), 0, 0 FROM "automations" t;
--> statement-breakpoint
INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", coalesce(t."name", '') || ' ' || coalesce(t."description", '') || ' ' || coalesce(t."trigger_type", '') FROM "search_docs" d JOIN "automations" t ON t."uuid" = d."record_id" WHERE d."collection" = 'automations' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts");
