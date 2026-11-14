DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at INTEGER NOT NULL,
  date TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  address_label TEXT,
  source TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX points_date_idx ON points (date, captured_at);
--> statement-breakpoint
CREATE TABLE segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  date TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  end_lat REAL,
  end_lng REAL,
  place_name TEXT,
  address TEXT,
  distance_m REAL,
  activity_type TEXT,
  source TEXT NOT NULL,
  label_locked INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX segments_date_idx ON segments (date, start_at);
--> statement-breakpoint
CREATE TABLE named_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m REAL NOT NULL DEFAULT 200,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  format TEXT NOT NULL,
  segment_count INTEGER NOT NULL DEFAULT 0,
  point_count INTEGER NOT NULL DEFAULT 0,
  first_date TEXT,
  last_date TEXT,
  created_at INTEGER NOT NULL
);
