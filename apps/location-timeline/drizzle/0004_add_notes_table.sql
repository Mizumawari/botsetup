CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`segment_id` integer,
	`lat` real,
	`lng` real,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
