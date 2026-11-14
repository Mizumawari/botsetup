// Drizzle schema for the location timeline space.
//
// points: raw location samples (live captures from the paired phone via the
// user's agent, browser-geolocation records, and thinned points parsed out of
// imported Google Timeline files). Append-only.
// segments: the timeline itself — stays and moves. Imported Google segments
// are stored verbatim (source = 'import'); segments derived from points are
// rebuilt per JST date (source = 'derived').
// named_places: user labels (自宅, 実家, …) anchored to coordinates; derived
// stays within the radius inherit the name.
// imports: one row per imported file, for the import history panel.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const points = sqliteTable("points", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  capturedAt: integer("captured_at").notNull(), // epoch ms (UTC instant)
  date: text("date").notNull(), // Asia/Tokyo calendar date, YYYY-MM-DD
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  accuracyM: real("accuracy_m"),
  addressLabel: text("address_label"),
  source: text("source", { enum: ["live", "browser", "import"] }).notNull(),
});

export const segments = sqliteTable("segments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["stay", "move"] }).notNull(),
  startAt: integer("start_at").notNull(), // epoch ms
  endAt: integer("end_at").notNull(), // epoch ms
  date: text("date").notNull(), // Asia/Tokyo date of startAt
  lat: real("lat").notNull(), // stay center, or move start
  lng: real("lng").notNull(),
  endLat: real("end_lat"), // move end only
  endLng: real("end_lng"),
  placeName: text("place_name"),
  address: text("address"),
  distanceM: real("distance_m"), // moves only
  activityType: text("activity_type"), // moves only, e.g. WALKING
  source: text("source", { enum: ["import", "derived"] }).notNull(),
  labelLocked: integer("label_locked").notNull().default(0),
});

export const namedPlaces = sqliteTable("named_places", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  radiusM: real("radius_m").notNull().default(200),
  createdAt: integer("created_at").notNull(),
});

// photos: user-uploaded photos attached to a stay. The image bytes live in
// blob storage (blobKey); this row anchors the photo to a JST date and the
// stay's coordinates. Anchoring by coordinates (not segment id) is
// deliberate: derived segments are deleted and rebuilt whenever a new point
// lands, so a photo must re-attach to whichever stay is displayed within
// 200 m of the anchor on that date. segmentId is kept only as a hint of
// which stay it was added from.
export const photos = sqliteTable("photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // Asia/Tokyo calendar date, YYYY-MM-DD
  segmentId: integer("segment_id"),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  blobKey: text("blob_key").notNull(),
  contentType: text("content_type").notNull(),
  caption: text("caption"),
  createdAt: integer("created_at").notNull(),
});

// notes: the user's own one-line memos (一言). A note is either day-level
// (lat/lng null — "today was like this") or anchored to a stay by date +
// coordinates, using the same anchoring rule as photos so it survives
// derived-segment rebuilds. segmentId is only a hint of where it was added.
export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // Asia/Tokyo calendar date, YYYY-MM-DD
  segmentId: integer("segment_id"),
  lat: real("lat"),
  lng: real("lng"),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const imports = sqliteTable("imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileName: text("file_name").notNull(),
  format: text("format").notNull(),
  segmentCount: integer("segment_count").notNull().default(0),
  pointCount: integer("point_count").notNull().default(0),
  firstDate: text("first_date"),
  lastDate: text("last_date"),
  createdAt: integer("created_at").notNull(),
});
