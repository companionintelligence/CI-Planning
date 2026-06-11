CREATE TABLE `habits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`title` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`start_time_earliest` text NOT NULL,
	`start_time_latest` text NOT NULL,
	`days_of_week` text DEFAULT '1,2,3,4,5',
	`enabled` integer DEFAULT true,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`started_at` text DEFAULT CURRENT_TIMESTAMP,
	`finished_at` text,
	`status` text DEFAULT 'running',
	`items_created` integer DEFAULT 0,
	`items_updated` integer DEFAULT 0,
	`log` text,
	FOREIGN KEY (`job_id`) REFERENCES `scheduled_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text
);
--> statement-breakpoint
CREATE TABLE `possible_task_tags` (
	`possible_task_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`possible_task_id`) REFERENCES `possible_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `possible_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`raw_title` text NOT NULL,
	`raw_summary` text,
	`proposed_due_at` text,
	`proposed_priority` integer,
	`proposed_owner_id` integer,
	`source_kind` text,
	`source_ref` text,
	`source_payload` text,
	`confidence` real,
	`status` text DEFAULT 'pending',
	`promoted_task_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`proposed_owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`promoted_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`cron` text NOT NULL,
	`enabled` integer DEFAULT true,
	`last_run_at` text,
	`next_run_at` text,
	`config` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_jobs_name_unique` ON `scheduled_jobs` (`name`);--> statement-breakpoint
CREATE TABLE `scheduling_prefs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`workday_start` text DEFAULT '09:00',
	`workday_end` text DEFAULT '18:00',
	`deep_work_windows` text,
	`max_focus_block_minutes` integer DEFAULT 90,
	`min_break_minutes` integer DEFAULT 10,
	`day_theme` text,
	`planning_mode` text DEFAULT 'ritual',
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`task_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`notes` text,
	`due_at` text,
	`task_time` text,
	`estimated_minutes` integer,
	`actual_minutes` integer,
	`priority` integer DEFAULT 3,
	`status` text DEFAULT 'open',
	`parent_id` integer,
	`owner_id` integer,
	`source_kind` text DEFAULT 'manual',
	`source_ref` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`completed_at` text,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `time_blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer,
	`title` text NOT NULL,
	`block_kind` text DEFAULT 'task',
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`is_locked` integer DEFAULT false,
	`is_auto` integer DEFAULT true,
	`source_kind` text DEFAULT 'manual',
	`source_ref` text,
	`status` text DEFAULT 'planned',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
