-- Tasks now carry a type - what KIND of work they are (bug, feature, chore), where priority says how soon.
-- Each board holds its own catalog (`task_types_json`, {key,label,color,icon}[], domain/boards.ts) and a card
-- names one key (`task_type`, null = untyped). Every board saved before types existed gets the same starter
-- catalog a new board gets (DEFAULT_TASK_TYPES), so the picker is not empty on the boards people already use;
-- existing cards stay untyped. `task_type_display` is how a task tile shows its type (icon, label or both);
-- every board starts on the glyph alone.
ALTER TABLE `boards` ADD `task_types_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `boards` ADD `task_type_display` text DEFAULT 'icon' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `task_type` text;--> statement-breakpoint
UPDATE `boards`
SET `task_types_json` = '[{"key":"feature","label":"Feature","color":"#16a34a","icon":"feature"},{"key":"bug","label":"Bug","color":"#dc2626","icon":"bug"},{"key":"improvement","label":"Improvement","color":"#2563eb","icon":"improvement"},{"key":"chore","label":"Chore","color":"#64748b","icon":"chore"}]'
WHERE `task_types_json` = '[]';
