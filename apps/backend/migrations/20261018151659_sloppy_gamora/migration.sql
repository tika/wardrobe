CREATE TABLE `items` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`part` text NOT NULL,
	`color` text NOT NULL,
	`secondaryColor` text,
	`palette` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`hasModeled` integer DEFAULT false NOT NULL,
	`importJobId` text NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`status` text NOT NULL,
	`metadata` text NOT NULL,
	`stages` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
