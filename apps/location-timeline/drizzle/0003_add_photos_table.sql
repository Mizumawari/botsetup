CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  segment_id INTEGER,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  blob_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  caption TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX photos_date_idx ON photos (date);
