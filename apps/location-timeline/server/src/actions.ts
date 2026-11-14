// Actions for the location timeline.
//
// Data flow:
// - Live: `captureNow` spawns the user's agent, which reads the paired
//   phone's current location (always-on sharing) and calls `saveLivePoint`
//   back. The browser can also save its own fix via `recordPoint`.
// - Past: the client parses a Google Timeline export file locally and uploads
//   normalized rows through `importSegments` (visits/activities, stored
//   verbatim) and `importPoints` (raw breadcrumbs, thinned).
// - `rebuildDerivedForDate` turns one JST date's points into stay/move
//   segments, skipping ranges already covered by imported segments, and
//   applying the user's named places. User-renamed stays survive rebuilds.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
type SpaceDb,
} from "@hatch/space-sdk";
import { and, asc, eq, gt, gte, lt, lte } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import { privileged } from "@space/privileged";

type Db = SpaceDb<typeof schema>;

// ---------- time helpers (all day boundaries are Asia/Tokyo) ----------

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstDateOf(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function jstDayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00+09:00`);
}

function haversineM(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------- derived segmentation ----------

const STAY_RADIUS_M = 200;
const STAY_MIN_MS = 10 * 60 * 1000;

async function rebuildDerivedForDate(ctx: Ctx, date: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  const dayStart = jstDayStartMs(date);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  // Ranges this date already covered by imported segments stay untouched.
  const imported = await db
    .select()
    .from(schema.segments)
    .where(
      and(
        eq(schema.segments.source, "import"),
        lt(schema.segments.startAt, dayEnd),
        gt(schema.segments.endAt, dayStart),
      ),
    );
  const covered = imported.map((s) => ({ start: s.startAt, end: s.endAt }));
  const isCovered = (start: number, end: number) =>
    covered.some((c) => start < c.end && end > c.start);

  // Points for this JST date plus the tail of the previous evening, so a
  // stay that crosses midnight still clusters.
  const dayPoints = await db
    .select()
    .from(schema.points)
    .where(
      and(
        gte(schema.points.capturedAt, dayStart - 6 * 60 * 60 * 1000),
        lt(schema.points.capturedAt, dayEnd),
      ),
    )
    .orderBy(asc(schema.points.capturedAt));

  // Preserve user-renamed stays: center -> name.
  const previousDerived = await db
    .select()
    .from(schema.segments)
    .where(and(eq(schema.segments.source, "derived"), eq(schema.segments.date, date)));
  const lockedNames = previousDerived
    .filter((s) => s.labelLocked === 1 && s.placeName)
    .map((s) => ({ lat: s.lat, lng: s.lng, name: s.placeName as string }));

  const places = await db.select().from(schema.namedPlaces);
  const labelFor = (lat: number, lng: number): string | null => {
    for (const locked of lockedNames) {
      if (haversineM(lat, lng, locked.lat, locked.lng) <= STAY_RADIUS_M) {
        return locked.name;
      }
    }
    for (const place of places) {
      if (haversineM(lat, lng, place.lat, place.lng) <= place.radiusM) {
        return place.name;
      }
    }
    return null;
  };

  // Cluster points into stays: a run of points within STAY_RADIUS_M of the
  // running centroid lasting at least STAY_MIN_MS.
  type Cluster = {
    startIdx: number;
    endIdx: number;
    latSum: number;
    lngSum: number;
  };
  const clusters: Cluster[] = [];
  let current: Cluster | null = null;
  const flush = () => {
    if (current) clusters.push(current);
    current = null;
  };
  dayPoints.forEach((point, idx) => {
    if (!current) {
      current = { startIdx: idx, endIdx: idx, latSum: point.lat, lngSum: point.lng };
      return;
    }
    const count = current.endIdx - current.startIdx + 1;
    const cLat = current.latSum / count;
    const cLng = current.lngSum / count;
    if (haversineM(cLat, cLng, point.lat, point.lng) <= STAY_RADIUS_M) {
      current.endIdx = idx;
      current.latSum += point.lat;
      current.lngSum += point.lng;
    } else {
      flush();
      current = { startIdx: idx, endIdx: idx, latSum: point.lat, lngSum: point.lng };
    }
  });
  flush();

  type NewSegment = typeof schema.segments.$inferInsert;
  const stays: (NewSegment & { firstPointIdx: number; lastPointIdx: number })[] = [];
  for (const cluster of clusters) {
    const first = dayPoints[cluster.startIdx];
    const last = dayPoints[cluster.endIdx];
    if (!first || !last) continue;
    if (last.capturedAt - first.capturedAt < STAY_MIN_MS) continue;
    const count = cluster.endIdx - cluster.startIdx + 1;
    const lat = cluster.latSum / count;
    const lng = cluster.lngSum / count;
    const inCluster = dayPoints.slice(cluster.startIdx, cluster.endIdx + 1);
    const address =
      [...inCluster].reverse().find((p) => p.addressLabel)?.addressLabel ?? null;
    stays.push({
      kind: "stay",
      startAt: first.capturedAt,
      endAt: last.capturedAt,
      date,
      lat,
      lng,
      placeName: labelFor(lat, lng),
      address,
      source: "derived",
      labelLocked: lockedNames.some(
        (l) => haversineM(lat, lng, l.lat, l.lng) <= STAY_RADIUS_M,
      )
        ? 1
        : 0,
      firstPointIdx: cluster.startIdx,
      lastPointIdx: cluster.endIdx,
    });
  }

  const derived: NewSegment[] = [];
  stays.forEach((stay, i) => {
    const { firstPointIdx: _firstPointIdx, lastPointIdx, ...clean } = stay;
    if (!isCovered(stay.startAt, stay.endAt) && stay.endAt >= dayStart) {
      derived.push(clean);
    }
    const next = stays[i + 1];
    if (!next) return;
    // Move between this stay and the next, from the points in between.
    const between = dayPoints.slice(lastPointIdx, next.firstPointIdx + 1);
    if (between.length < 2) return;
    let distance = 0;
    for (let j = 1; j < between.length; j++) {
      const a = between[j - 1];
      const b = between[j];
      if (a && b) distance += haversineM(a.lat, a.lng, b.lat, b.lng);
    }
    const first = between[0];
    const last = between[between.length - 1];
    if (!first || !last) return;
    if (distance < 50) return;
    if (isCovered(first.capturedAt, last.capturedAt)) return;
    derived.push({
      kind: "move",
      startAt: first.capturedAt,
      endAt: last.capturedAt,
      date,
      lat: first.lat,
      lng: first.lng,
      endLat: last.lat,
      endLng: last.lng,
      distanceM: Math.round(distance),
      source: "derived",
      labelLocked: 0,
    });
  });

  const statements: BatchItem<"sqlite">[] = [
    db
      .delete(schema.segments)
      .where(
        and(eq(schema.segments.source, "derived"), eq(schema.segments.date, date)),
      ),
  ];
  for (const seg of derived) {
    statements.push(db.insert(schema.segments).values(seg));
  }
  const [firstStmt, ...rest] = statements;
  if (firstStmt) await db.batch([firstStmt, ...rest]);
}

async function upsertNamedPlace(
  db: Db,
  name: string,
  lat: number,
  lng: number,
): Promise<void> {
  const all = await db.select().from(schema.namedPlaces);
  const existing = all.find((p) => p.name === name);
  if (existing) {
    await db
      .update(schema.namedPlaces)
      .set({ lat, lng })
      .where(eq(schema.namedPlaces.id, existing.id));
  } else {
    await db
      .insert(schema.namedPlaces)
      .values({ name, lat, lng, radiusM: 200, createdAt: Date.now() });
  }
}

// ---------- shared schemas ----------

const photoOut = z.object({
  id: z.number(),
  url: z.string(),
  caption: z.string().nullable(),
});

const noteOut = z.object({
  id: z.number(),
  text: z.string(),
});

const segmentOut = z.object({
  id: z.number(),
  kind: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  lat: z.number(),
  lng: z.number(),
  endLat: z.number().nullable(),
  endLng: z.number().nullable(),
  placeName: z.string().nullable(),
  address: z.string().nullable(),
  distanceM: z.number().nullable(),
  activityType: z.string().nullable(),
  source: z.string(),
  photos: z.array(photoOut),
  notes: z.array(noteOut),
});

const doneResponse = z.object({ ok: z.literal(true) });

const importSegmentIn = z.object({
  kind: z.enum(["stay", "move"]),
  startAt: z.number().int(),
  endAt: z.number().int(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  endLat: z.number().min(-90).max(90).nullable().optional(),
  endLng: z.number().min(-180).max(180).nullable().optional(),
  placeName: z.string().max(200).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  distanceM: z.number().nonnegative().nullable().optional(),
  activityType: z.string().max(60).nullable().optional(),
  semanticType: z.string().max(60).nullable().optional(),
});

const importPointIn = z.object({
  capturedAt: z.number().int(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().nullable().optional(),
});

// ---------- shared import inserters (client uploads + inbox file) ----------

type ImportSegmentRow = z.infer<typeof importSegmentIn>;
type ImportPointRow = z.infer<typeof importPointIn>;

/**
 * Inserts visit/activity segments parsed from a Google Timeline export,
 * skipping rows already imported (same kind/start/end/center). HOME/WORK
 * semantic types (any casing — iOS writes "Home") seed named places.
 */
async function insertImportedSegments(
  ctx: Ctx,
  rows: ImportSegmentRow[],
): Promise<{ added: number; skipped: number }> {
  const db = ctx.db<typeof schema>();
  if (rows.length === 0) return { added: 0, skipped: 0 };
  const minStart = Math.min(...rows.map((s) => s.startAt));
  const maxStart = Math.max(...rows.map((s) => s.startAt));
  const existing = await db
    .select()
    .from(schema.segments)
    .where(
      and(
        eq(schema.segments.source, "import"),
        gte(schema.segments.startAt, minStart - 1000),
        lte(schema.segments.startAt, maxStart + 1000),
      ),
    );
  const keyOf = (
    kind: string,
    startAt: number,
    endAt: number,
    lat: number,
    lng: number,
  ) => `${kind}|${startAt}|${endAt}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
  const seen = new Set(
    existing.map((s) => keyOf(s.kind, s.startAt, s.endAt, s.lat, s.lng)),
  );
  let added = 0;
  let skipped = 0;
  const statements: BatchItem<"sqlite">[] = [];
  for (const seg of rows) {
    const key = keyOf(seg.kind, seg.startAt, seg.endAt, seg.lat, seg.lng);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    added += 1;
    statements.push(
      db.insert(schema.segments).values({
        kind: seg.kind,
        startAt: seg.startAt,
        endAt: seg.endAt,
        date: jstDateOf(seg.startAt),
        lat: seg.lat,
        lng: seg.lng,
        endLat: seg.endLat ?? null,
        endLng: seg.endLng ?? null,
        placeName: seg.placeName ?? null,
        address: seg.address ?? null,
        distanceM: seg.distanceM ?? null,
        activityType: seg.activityType ?? null,
        source: "import",
        labelLocked: 0,
      }),
    );
    if (seg.kind === "stay" && seg.semanticType) {
      const upper = seg.semanticType.toUpperCase();
      const label = upper === "HOME" ? "自宅" : upper === "WORK" ? "職場" : null;
      if (label) {
        await upsertNamedPlace(db, label, seg.lat, seg.lng);
      }
    }
  }
  const [firstStmt, ...rest] = statements;
  if (firstStmt) await db.batch([firstStmt, ...rest]);
  return { added, skipped };
}

/**
 * Inserts raw import points (dedupe against already-imported points) and
 * returns the JST dates they touch. Callers decide when to re-derive those
 * dates — per batch for client uploads, once at the end for the inbox file.
 */
async function insertImportedPointsRaw(
  ctx: Ctx,
  rows: ImportPointRow[],
): Promise<{ added: number; skipped: number; affectedDates: string[] }> {
  const db = ctx.db<typeof schema>();
  if (rows.length === 0) return { added: 0, skipped: 0, affectedDates: [] };
  const sorted = [...rows].sort((a, b) => a.capturedAt - b.capturedAt);
  const minAt = sorted[0]!.capturedAt;
  const maxAt = sorted[sorted.length - 1]!.capturedAt;
  const existing = await db
    .select()
    .from(schema.points)
    .where(
      and(
        eq(schema.points.source, "import"),
        gte(schema.points.capturedAt, minAt),
        lte(schema.points.capturedAt, maxAt),
      ),
    );
  const keyOf = (capturedAt: number, lat: number, lng: number) =>
    `${capturedAt}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
  const seen = new Set(existing.map((p) => keyOf(p.capturedAt, p.lat, p.lng)));
  let added = 0;
  let skipped = 0;
  const statements: BatchItem<"sqlite">[] = [];
  const affectedDates = new Set<string>();
  for (const point of sorted) {
    const key = keyOf(point.capturedAt, point.lat, point.lng);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    added += 1;
    const date = jstDateOf(point.capturedAt);
    affectedDates.add(date);
    statements.push(
      db.insert(schema.points).values({
        capturedAt: point.capturedAt,
        date,
        lat: point.lat,
        lng: point.lng,
        accuracyM: point.accuracyM ?? null,
        addressLabel: null,
        source: "import",
      }),
    );
  }
  const [firstStmt, ...rest] = statements;
  if (firstStmt) await db.batch([firstStmt, ...rest]);
  return { added, skipped, affectedDates: [...affectedDates] };
}

/**
 * Same thinning rule as the client parser: keep a breadcrumb only when it
 * moved at least 25 m or at least 10 minutes passed since the last kept one.
 */
function thinImportPoints(points: ImportPointRow[]): ImportPointRow[] {
  const sorted = [...points].sort((a, b) => a.capturedAt - b.capturedAt);
  const kept: ImportPointRow[] = [];
  for (const point of sorted) {
    const last = kept[kept.length - 1];
    if (!last) {
      kept.push(point);
      continue;
    }
    const dist = haversineM(last.lat, last.lng, point.lat, point.lng);
    const dt = point.capturedAt - last.capturedAt;
    if (dist >= 25 || dt >= 10 * 60 * 1000) kept.push(point);
  }
  return kept;
}

export const Actions = {
  getDay: defineAction({
    description:
      "Returns one Asia/Tokyo date's timeline: stay/move segments, the day's raw points, and a summary.",
    request: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    response: z.object({
      date: z.string(),
      segments: z.array(segmentOut),
      loosePhotos: z.array(photoOut),
      dayNotes: z.array(noteOut),
      points: z.array(
        z.object({
          lat: z.number(),
          lng: z.number(),
          capturedAt: z.string(),
          addressLabel: z.string().nullable(),
        }),
      ),
      summary: z.object({
        stayCount: z.number(),
        moveCount: z.number(),
        provisionalCount: z.number(),
        totalDistanceM: z.number(),
        pointCount: z.number(),
        firstAt: z.string().nullable(),
        lastAt: z.string().nullable(),
      }),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const dayStart = jstDayStartMs(args.date);
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      const segs = await db
        .select()
        .from(schema.segments)
        .where(
          and(
            lt(schema.segments.startAt, dayEnd),
            gt(schema.segments.endAt, dayStart),
          ),
        )
        .orderBy(asc(schema.segments.startAt));
      const pts = await db
        .select()
        .from(schema.points)
        .where(
          and(
            gte(schema.points.capturedAt, dayStart),
            lt(schema.points.capturedAt, dayEnd),
          ),
        )
        .orderBy(asc(schema.points.capturedAt));
      // Display-time label: an unnamed stay sitting on a named place shows
      // that name. Stored rows are never rewritten here.
      const places = await db.select().from(schema.namedPlaces);
      const displayName = (s: (typeof segs)[number]): string | null => {
        if (s.placeName) return s.placeName;
        if (s.kind !== "stay") return null;
        for (const place of places) {
          if (haversineM(s.lat, s.lng, place.lat, place.lng) <= place.radiusM) {
            return place.name;
          }
        }
        return null;
      };
      const stays = segs.filter((s) => s.kind === "stay");
      const moves = segs.filter((s) => s.kind === "move");

      // Provisional records: points no stored segment covers (e.g. a brief
      // stop that never met the 10-minute stay rule) are still shown, so
      // every recorded fix appears on the day at its own time. Consecutive
      // uncovered points within the stay radius and 30 minutes of each
      // other cluster into one provisional entry. These are display-only;
      // nothing is written back.
      const uncovered = pts.filter(
        (p) =>
          !segs.some((s) => p.capturedAt >= s.startAt && p.capturedAt <= s.endAt),
      );
      type ProvCluster = {
        items: (typeof pts)[number][];
        latSum: number;
        lngSum: number;
      };
      const provClusters: ProvCluster[] = [];
      let provCurrent: ProvCluster | null = null;
      for (const p of uncovered) {
        if (provCurrent) {
          const lastItem =
            provCurrent.items[provCurrent.items.length - 1]!;
          const cLat = provCurrent.latSum / provCurrent.items.length;
          const cLng = provCurrent.lngSum / provCurrent.items.length;
          if (
            haversineM(cLat, cLng, p.lat, p.lng) <= STAY_RADIUS_M &&
            p.capturedAt - lastItem.capturedAt <= 30 * 60 * 1000
          ) {
            provCurrent.items.push(p);
            provCurrent.latSum += p.lat;
            provCurrent.lngSum += p.lng;
            continue;
          }
          provClusters.push(provCurrent);
          provCurrent = null;
        }
        provCurrent = { items: [p], latSum: p.lat, lngSum: p.lng };
      }
      if (provCurrent) provClusters.push(provCurrent);
      const provisional = provClusters.map((cluster, i) => {
        const first = cluster.items[0]!;
        const last = cluster.items[cluster.items.length - 1]!;
        const lat = cluster.latSum / cluster.items.length;
        const lng = cluster.lngSum / cluster.items.length;
        const address =
          [...cluster.items].reverse().find((p) => p.addressLabel)
            ?.addressLabel ?? null;
        let placeName: string | null = null;
        for (const place of places) {
          if (haversineM(lat, lng, place.lat, place.lng) <= place.radiusM) {
            placeName = place.name;
            break;
          }
        }
        return {
          id: -(i + 1),
          kind: "stay",
          startAt: new Date(first.capturedAt).toISOString(),
          endAt: new Date(last.capturedAt).toISOString(),
          lat,
          lng,
          endLat: null,
          endLng: null,
          placeName,
          address,
          distanceM: null,
          activityType: null,
          source: "provisional",
          photos: [] as z.infer<typeof photoOut>[],
          notes: [] as z.infer<typeof noteOut>[],
        };
      });

      const realSegments = segs.map((s) => ({
        id: s.id,
        kind: s.kind,
        startAt: new Date(s.startAt).toISOString(),
        endAt: new Date(s.endAt).toISOString(),
        lat: s.lat,
        lng: s.lng,
        endLat: s.endLat,
        endLng: s.endLng,
        placeName: displayName(s),
        address: s.address,
        distanceM: s.distanceM,
        activityType: s.activityType,
        source: s.source,
        photos: [] as z.infer<typeof photoOut>[],
        notes: [] as z.infer<typeof noteOut>[],
      }));

      // Photos: each photo is anchored to a date + coordinates and attaches
      // to the nearest displayed stay within the stay radius. Photos whose
      // stay no longer exists on that date come back as loosePhotos so they
      // are never silently hidden.
      const allSegments = [...realSegments, ...provisional].sort((a, b) =>
        a.startAt.localeCompare(b.startAt),
      );
      const photoRows = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.date, args.date))
        .orderBy(asc(schema.photos.id));
      const loosePhotos: z.infer<typeof photoOut>[] = [];
      for (const photo of photoRows) {
        let best: (typeof allSegments)[number] | null = null;
        let bestDist = Infinity;
        for (const seg of allSegments) {
          if (seg.kind !== "stay") continue;
          const d = haversineM(seg.lat, seg.lng, photo.lat, photo.lng);
          if (d <= STAY_RADIUS_M && d < bestDist) {
            best = seg;
            bestDist = d;
          }
        }
        const entry = {
          id: photo.id,
          url: await ctx.blobs.getUrl(photo.blobKey),
          caption: photo.caption,
        };
        if (best) best.photos.push(entry);
        else loosePhotos.push(entry);
      }

      // Notes: day-level notes (no coordinates) come back as dayNotes;
      // stay-anchored notes attach to the nearest displayed stay within the
      // stay radius, exactly like photos. A note whose stay no longer
      // displays falls back into dayNotes so it never disappears.
      const noteRows = await db
        .select()
        .from(schema.notes)
        .where(eq(schema.notes.date, args.date))
        .orderBy(asc(schema.notes.id));
      const dayNotes: z.infer<typeof noteOut>[] = [];
      for (const note of noteRows) {
        const entry = { id: note.id, text: note.text };
        if (note.lat == null || note.lng == null) {
          dayNotes.push(entry);
          continue;
        }
        let best: (typeof allSegments)[number] | null = null;
        let bestDist = Infinity;
        for (const seg of allSegments) {
          if (seg.kind !== "stay") continue;
          const d = haversineM(seg.lat, seg.lng, note.lat, note.lng);
          if (d <= STAY_RADIUS_M && d < bestDist) {
            best = seg;
            bestDist = d;
          }
        }
        if (best) best.notes.push(entry);
        else dayNotes.push(entry);
      }

      return {
        date: args.date,
        segments: allSegments,
        loosePhotos,
        dayNotes,
        points: pts.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          capturedAt: new Date(p.capturedAt).toISOString(),
          addressLabel: p.addressLabel,
        })),
        summary: {
          stayCount: stays.length,
          moveCount: moves.length,
          provisionalCount: provisional.length,
          totalDistanceM: Math.round(
            moves.reduce((sum, m) => sum + (m.distanceM ?? 0), 0),
          ),
          pointCount: pts.length,
          firstAt: pts[0] ? new Date(pts[0].capturedAt).toISOString() : null,
          lastAt: pts[pts.length - 1]
            ? new Date(pts[pts.length - 1]!.capturedAt).toISOString()
            : null,
        },
      };
    },
  }),

  listDays: defineAction({
    description:
      "Returns per-date stay/move counts and total distance for every date that has segments, for calendar navigation.",
    request: z.object({}),
    response: z.object({
      days: z.array(
        z.object({
          date: z.string(),
          stayCount: z.number(),
          moveCount: z.number(),
          distanceM: z.number(),
        }),
      ),
      firstDate: z.string().nullable(),
      lastDate: z.string().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          date: schema.segments.date,
          kind: schema.segments.kind,
          distanceM: schema.segments.distanceM,
        })
        .from(schema.segments);
      const byDate = new Map<
        string,
        { date: string; stayCount: number; moveCount: number; distanceM: number }
      >();
      for (const row of rows) {
        const entry =
          byDate.get(row.date) ??
          { date: row.date, stayCount: 0, moveCount: 0, distanceM: 0 };
        if (row.kind === "stay") entry.stayCount += 1;
        else {
          entry.moveCount += 1;
          entry.distanceM += row.distanceM ?? 0;
        }
        byDate.set(row.date, entry);
      }
      // Dates that only have raw points (nothing has become a stay or move
      // yet) still belong on the calendar.
      const pointDates = await db
        .select({ date: schema.points.date })
        .from(schema.points);
      for (const row of pointDates) {
        if (!byDate.has(row.date)) {
          byDate.set(row.date, {
            date: row.date,
            stayCount: 0,
            moveCount: 0,
            distanceM: 0,
          });
        }
      }
      const days = [...byDate.values()]
        .map((d) => ({ ...d, distanceM: Math.round(d.distanceM) }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return {
        days,
        firstDate: days[0]?.date ?? null,
        lastDate: days[days.length - 1]?.date ?? null,
      };
    },
  }),

  captureNow: defineAction({
    description:
      "Asks the user's agent to read the paired phone's current location once and save it via saveLivePoint.",
    request: z.object({}),
    response: z.object({
      started: z.boolean(),
      taskId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    async handler(ctx) {
      const hourBucket = Math.floor(Date.now() / 3600000);
      const result = await ctx.agent.spawnTask(
        [
          "位置タイムラインの定期記録です。ペアリング済み iPhone の現在地を、位置共有の読み取りで1回だけ取得してください。",
          "取得できたら、緯度・経度・精度(m)・住所ラベル(分かる範囲で)・取得時刻を saveLivePoint アクションで保存してください。",
          "位置が取得できない場合は、推測で座標を作らず、その旨を報告して終了してください。",
        ].join("\n"),
        { expectsAction: "saveLivePoint", dedupeKey: `live-capture-${hourBucket}` },
      );
      if (!result.ok) {
        return { started: false, taskId: null, error: result.error };
      }
      return { started: true, taskId: result.taskId, error: null };
    },
  }),

  saveLivePoint: defineAction({
    description:
      "Saves one current-location fix read from the user's phone (called by the agent after captureNow).",
    request: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      accuracyM: z.number().nonnegative().nullable().optional(),
      addressLabel: z.string().max(300).nullable().optional(),
      capturedAt: z.string().datetime().optional(),
    }),
    response: z.object({ id: z.number(), date: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const capturedAt = args.capturedAt
        ? Date.parse(args.capturedAt)
        : Date.now();
      const date = jstDateOf(capturedAt);
      const inserted = await db
        .insert(schema.points)
        .values({
          capturedAt,
          date,
          lat: args.lat,
          lng: args.lng,
          accuracyM: args.accuracyM ?? null,
          addressLabel: args.addressLabel ?? null,
          source: "live",
        })
        .returning({ id: schema.points.id });
      const row = inserted[0];
      if (!row) throw new Error("saveLivePoint: insert returned no rows");
      await rebuildDerivedForDate(ctx, date);
      ctx.invalidateQueries();
      return { id: row.id, date };
    },
  }),

  recordPoint: defineAction({
    description:
      "Saves one location fix recorded by the browser on the user's own device.",
    request: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      accuracyM: z.number().nonnegative().nullable().optional(),
      capturedAt: z.number().int().optional(),
    }),
    response: z.object({ id: z.number(), date: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const capturedAt = args.capturedAt ?? Date.now();
      const date = jstDateOf(capturedAt);
      const inserted = await db
        .insert(schema.points)
        .values({
          capturedAt,
          date,
          lat: args.lat,
          lng: args.lng,
          accuracyM: args.accuracyM ?? null,
          addressLabel: null,
          source: "browser",
        })
        .returning({ id: schema.points.id });
      const row = inserted[0];
      if (!row) throw new Error("recordPoint: insert returned no rows");
      await rebuildDerivedForDate(ctx, date);
      ctx.invalidateQueries();
      return { id: row.id, date };
    },
  }),

  importSegments: defineAction({
    description:
      "Stores a batch of visit/activity segments parsed from a Google Timeline export file, verbatim.",
    request: z.object({
      fileName: z.string().min(1).max(300),
      format: z.string().min(1).max(60),
      segments: z.array(importSegmentIn).max(500),
    }),
    response: z.object({ added: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      const res = await insertImportedSegments(ctx, args.segments);
      if (res.added > 0) ctx.invalidateQueries();
      return res;
    },
  }),

  importPoints: defineAction({
    description:
      "Stores a batch of raw location points parsed from a Google Timeline export file and re-derives the affected dates.",
    request: z.object({
      points: z.array(importPointIn).max(2000),
    }),
    response: z.object({ added: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      const res = await insertImportedPointsRaw(ctx, args.points);
      for (const date of res.affectedDates) {
        await rebuildDerivedForDate(ctx, date);
      }
      if (res.added > 0) ctx.invalidateQueries();
      return { added: res.added, skipped: res.skipped };
    },
  }),

  finishImport: defineAction({
    description: "Records one completed file import in the import history.",
    request: z.object({
      fileName: z.string().min(1).max(300),
      format: z.string().min(1).max(60),
      segmentCount: z.number().int().nonnegative(),
      pointCount: z.number().int().nonnegative(),
      firstDate: z.string().nullable(),
      lastDate: z.string().nullable(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.imports)
        .values({
          fileName: args.fileName,
          format: args.format,
          segmentCount: args.segmentCount,
          pointCount: args.pointCount,
          firstDate: args.firstDate,
          lastDate: args.lastDate,
          createdAt: Date.now(),
        })
        .returning({ id: schema.imports.id });
      const row = inserted[0];
      if (!row) throw new Error("finishImport: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  importInboxTimeline: defineAction({
    description:
      "Imports the Google Timeline export file the user placed in the workspace inbox (google-timeline-2026-11-14.json, 2024-12-07 to 2026-11-14) as imported segments and thinned points, and records the import. Idempotent: if that file is already recorded in the import history, nothing is added.",
    request: z.object({}),
    response: z.object({
      alreadyImported: z.boolean(),
      fileName: z.string(),
      segmentCount: z.number(),
      pointCount: z.number(),
      segmentsAdded: z.number(),
      pointsAdded: z.number(),
      firstDate: z.string().nullable(),
      lastDate: z.string().nullable(),
    }),
    privileged: [privileged.readTimelineInboxChunk],
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const CHUNK = 400;
      const first = await ctx.executePrivileged(
        privileged.readTimelineInboxChunk,
        { offset: 0, limit: CHUNK },
      );

      // A completed import of this exact file is recorded once; a repeat
      // run reports the recorded counts instead of importing again.
      const prior = await db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.fileName, first.fileName));
      const done = prior[0];
      if (done) {
        return {
          alreadyImported: true,
          fileName: done.fileName,
          segmentCount: done.segmentCount,
          pointCount: done.pointCount,
          segmentsAdded: 0,
          pointsAdded: 0,
          firstDate: done.firstDate,
          lastDate: done.lastDate,
        };
      }

      let segmentsAdded = 0;
      let pointsAdded = 0;
      let minAt = Infinity;
      let maxAt = -Infinity;
      const rawPoints: ImportPointRow[] = [];
      const affectedDates = new Set<string>();

      const consume = async (items: typeof first.items) => {
        const segRows: ImportSegmentRow[] = [];
        for (const item of items) {
          minAt = Math.min(minAt, item.startAt);
          maxAt = Math.max(maxAt, item.endAt);
          if (item.visitLat !== null && item.visitLng !== null) {
            segRows.push({
              kind: "stay",
              startAt: item.startAt,
              endAt: item.endAt,
              lat: item.visitLat,
              lng: item.visitLng,
              semanticType: item.semanticType,
            });
          } else if (
            item.actStartLat !== null &&
            item.actStartLng !== null &&
            item.actEndLat !== null &&
            item.actEndLng !== null
          ) {
            segRows.push({
              kind: "move",
              startAt: item.startAt,
              endAt: item.endAt,
              lat: item.actStartLat,
              lng: item.actStartLng,
              endLat: item.actEndLat,
              endLng: item.actEndLng,
              distanceM: item.distanceM,
              activityType: item.activityType,
            });
          }
          for (const p of item.path) {
            rawPoints.push({ capturedAt: p.capturedAt, lat: p.lat, lng: p.lng });
            minAt = Math.min(minAt, p.capturedAt);
            maxAt = Math.max(maxAt, p.capturedAt);
          }
        }
        if (segRows.length > 0) {
          const res = await insertImportedSegments(ctx, segRows);
          segmentsAdded += res.added;
        }
        // Flush thinned points in bounded batches so one action call
        // never holds the whole file's breadcrumbs as insert statements.
        // Thinning is sequential, so a batch edge may keep one extra
        // point compared to thinning the whole set at once — harmless.
        while (rawPoints.length >= 2000) {
          const batch = thinImportPoints(rawPoints.splice(0, 2000));
          const res = await insertImportedPointsRaw(ctx, batch);
          pointsAdded += res.added;
          for (const d of res.affectedDates) affectedDates.add(d);
        }
      };

      await consume(first.items);
      for (let offset = CHUNK; offset < first.total; offset += CHUNK) {
        const chunk = await ctx.executePrivileged(
          privileged.readTimelineInboxChunk,
          { offset, limit: CHUNK },
        );
        await consume(chunk.items);
      }
      if (rawPoints.length > 0) {
        const res = await insertImportedPointsRaw(
          ctx,
          thinImportPoints(rawPoints),
        );
        pointsAdded += res.added;
        for (const d of res.affectedDates) affectedDates.add(d);
      }

      for (const date of affectedDates) {
        await rebuildDerivedForDate(ctx, date);
      }

      const firstDate = Number.isFinite(minAt) ? jstDateOf(minAt) : null;
      const lastDate = Number.isFinite(maxAt) ? jstDateOf(maxAt) : null;
      await db.insert(schema.imports).values({
        fileName: first.fileName,
        format: "iOS タイムライン書き出し",
        segmentCount: segmentsAdded,
        pointCount: pointsAdded,
        firstDate,
        lastDate,
        createdAt: Date.now(),
      });
      ctx.invalidateQueries();
      return {
        alreadyImported: false,
        fileName: first.fileName,
        segmentCount: segmentsAdded,
        pointCount: pointsAdded,
        segmentsAdded,
        pointsAdded,
        firstDate,
        lastDate,
      };
    },
  }),

  getImports: defineAction({
    description: "Lists past Timeline file imports, newest first.",
    request: z.object({}),
    response: z.object({
      imports: z.array(
        z.object({
          id: z.number(),
          fileName: z.string(),
          format: z.string(),
          segmentCount: z.number(),
          pointCount: z.number(),
          firstDate: z.string().nullable(),
          lastDate: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.imports)
        .orderBy(asc(schema.imports.id));
      return {
        imports: rows.reverse().map((r) => ({
          id: r.id,
          fileName: r.fileName,
          format: r.format,
          segmentCount: r.segmentCount,
          pointCount: r.pointCount,
          firstDate: r.firstDate,
          lastDate: r.lastDate,
          createdAt: new Date(r.createdAt).toISOString(),
        })),
      };
    },
  }),

  deleteImport: defineAction({
    description:
      "Removes one import: its imported segments and points in the import's date range are deleted and affected dates re-derived.",
    request: z.object({ id: z.number().int().positive() }),
    response: doneResponse,
    handler: async (ctx, args): Promise<z.infer<typeof doneResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, args.id));
      const target = rows[0];
      if (!target) return { ok: true };
      if (target.firstDate && target.lastDate) {
        const rangeStart = jstDayStartMs(target.firstDate);
        const rangeEnd = jstDayStartMs(target.lastDate) + 24 * 60 * 60 * 1000;
        await db
          .delete(schema.segments)
          .where(
            and(
              eq(schema.segments.source, "import"),
              gte(schema.segments.startAt, rangeStart),
              lt(schema.segments.startAt, rangeEnd),
            ),
          );
        await db
          .delete(schema.points)
          .where(
            and(
              eq(schema.points.source, "import"),
              gte(schema.points.capturedAt, rangeStart),
              lt(schema.points.capturedAt, rangeEnd),
            ),
          );
        // Re-derive each date in the range that still has points.
        for (
          let t = rangeStart;
          t < rangeEnd;
          t += 24 * 60 * 60 * 1000
        ) {
          await rebuildDerivedForDate(ctx, jstDateOf(t));
        }
      }
      await db.delete(schema.imports).where(eq(schema.imports.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  renameStay: defineAction({
    description:
      "Renames a stay segment; optionally registers the name as a named place so nearby stays inherit it.",
    request: z.object({
      segmentId: z.number().int().positive(),
      name: z.string().min(1).max(100),
      registerAsPlace: z.boolean().default(false),
    }),
    response: doneResponse,
    handler: async (ctx, args): Promise<z.infer<typeof doneResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.segments)
        .where(eq(schema.segments.id, args.segmentId));
      const stay = rows[0];
      if (!stay) return { ok: true };
      await db
        .update(schema.segments)
        .set({ placeName: args.name, labelLocked: 1 })
        .where(eq(schema.segments.id, args.segmentId));
      if (args.registerAsPlace) {
        await upsertNamedPlace(db, args.name, stay.lat, stay.lng);
        // Apply immediately to other unlocked stays within the radius.
        const allStays = await db
          .select()
          .from(schema.segments)
          .where(eq(schema.segments.kind, "stay"));
        const statements: BatchItem<"sqlite">[] = [];
        for (const other of allStays) {
          if (other.id === stay.id || other.labelLocked === 1) continue;
          if (haversineM(stay.lat, stay.lng, other.lat, other.lng) <= 200) {
            statements.push(
              db
                .update(schema.segments)
                .set({ placeName: args.name })
                .where(eq(schema.segments.id, other.id)),
            );
          }
        }
        const [firstStmt, ...rest] = statements;
        if (firstStmt) await db.batch([firstStmt, ...rest]);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  registerNamedPlace: defineAction({
    description:
      "Registers or updates a named place label (e.g. 自宅) anchored to coordinates, e.g. from an imported file's frequent places.",
    request: z.object({
      name: z.string().min(1).max(100),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
    response: doneResponse,
    handler: async (ctx, args): Promise<z.infer<typeof doneResponse>> => {
      const db = ctx.db<typeof schema>();
      await upsertNamedPlace(db, args.name, args.lat, args.lng);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getNamedPlaces: defineAction({
    description: "Lists the user's named places (labels anchored to coordinates).",
    request: z.object({}),
    response: z.object({
      places: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          lat: z.number(),
          lng: z.number(),
          radiusM: z.number(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.namedPlaces);
      return {
        places: rows.map((p) => ({
          id: p.id,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          radiusM: p.radiusM,
        })),
      };
    },
  }),

  deleteNamedPlace: defineAction({
    description: "Deletes one named place label.",
    request: z.object({ id: z.number().int().positive() }),
    response: doneResponse,
    handler: async (ctx, args): Promise<z.infer<typeof doneResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.namedPlaces)
        .where(eq(schema.namedPlaces.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addPhoto: defineAction({
    description:
      "Attaches one user-uploaded photo (base64 image bytes) to a stay, anchored to the stay's date and coordinates so it survives segment rebuilds.",
    request: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      segmentId: z.number().int().nullable().optional(),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      caption: z.string().max(200).nullable().optional(),
      dataBase64: z.string().min(1).max(14_000_000),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Anchor to the stay row's own coordinates when it is a stored
      // segment; provisional (display-only) stays pass their center
      // directly.
      let lat = args.lat;
      let lng = args.lng;
      let date = args.date;
      if (args.segmentId != null && args.segmentId > 0) {
        const rows = await db
          .select()
          .from(schema.segments)
          .where(eq(schema.segments.id, args.segmentId));
        const seg = rows[0];
        if (seg) {
          lat = seg.lat;
          lng = seg.lng;
          date = seg.date;
        }
      }
      const binary = atob(args.dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blobKey = `photos/${date}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      await ctx.blobs.put(blobKey, bytes, { contentType: args.mimeType });
      const inserted = await db
        .insert(schema.photos)
        .values({
          date,
          segmentId: args.segmentId ?? null,
          lat,
          lng,
          blobKey,
          contentType: args.mimeType,
          caption: args.caption ?? null,
          createdAt: Date.now(),
        })
        .returning({ id: schema.photos.id });
      const row = inserted[0];
      if (!row) throw new Error("addPhoto: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deletePhoto: defineAction({
    description: "Deletes one stay photo (its row; the blob is removed too).",
    request: z.object({ id: z.number().int().positive() }),
    response: doneResponse,
    handler: async (ctx, args): Promise<z.infer<typeof doneResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.photos)
        .where(eq(schema.photos.id, args.id));
      const photo = rows[0];
      if (photo) {
        await ctx.blobs.delete(photo.blobKey).catch(() => undefined);
        await db
          .delete(schema.photos)
          .where(eq(schema.photos.id, args.id));
        ctx.invalidateQueries();
      }
      return { ok: true };
    },
  }),

  addNote: defineAction({
    description:
      "Adds one short memo (一言) to a day, or anchored to a stay on that day when coordinates are given.",
    request: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      text: z.string().trim().min(1).max(500),
      segmentId: z.number().int().nullable().optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Anchor to the stay row's own coordinates when it is a stored
      // segment; provisional (display-only) stays pass their center
      // directly. No coordinates at all means a day-level note.
      let lat = args.lat ?? null;
      let lng = args.lng ?? null;
      let date = args.date;
      if (args.segmentId != null && args.segmentId > 0) {
        const rows = await db
          .select()
          .from(schema.segments)
          .where(eq(schema.segments.id, args.segmentId));
        const seg = rows[0];
        if (seg) {
          lat = seg.lat;
          lng = seg.lng;
          date = seg.date;
        }
      }
      if (lat == null || lng == null) {
        lat = null;
        lng = null;
      }
      const inserted = await db
        .insert(schema.notes)
        .values({
          date,
          segmentId: args.segmentId ?? null,
          lat,
          lng,
          text: args.text,
          createdAt: Date.now(),
        })
        .returning({ id: schema.notes.id });
      const row = inserted[0];
      if (!row) throw new Error("addNote: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteNote: defineAction({
    description: "Deletes one memo (一言).",
    request: z.object({ id: z.number().int().positive() }),
    response: doneResponse,
    handler: async (ctx, args): Promise<z.infer<typeof doneResponse>> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.notes).where(eq(schema.notes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getMonthSummary: defineAction({
    description:
      "Returns a monthly summary for a YYYY-MM month: totals, top places, activity breakdown, first-time places, and daily breakdown.",
    request: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }),
    response: z.object({
      month: z.string(),
      totalDistanceM: z.number(),
      stayCount: z.number(),
      moveCount: z.number(),
      pointCount: z.number(),
      photoCount: z.number(),
      noteCount: z.number(),
      activeDays: z.number(),
      topPlaces: z.array(
        z.object({
          name: z.string(),
          lat: z.number(),
          lng: z.number(),
          visitCount: z.number(),
          totalMinutes: z.number(),
        }),
      ),
      activities: z.array(
        z.object({
          type: z.string().nullable(),
          count: z.number(),
          distanceM: z.number(),
        }),
      ),
      firstTimePlaces: z.array(
        z.object({
          name: z.string(),
          lat: z.number(),
          lng: z.number(),
          firstDate: z.string(),
        }),
      ),
      daily: z.array(
        z.object({
          date: z.string(),
          stayCount: z.number(),
          moveCount: z.number(),
          distanceM: z.number(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [yy = 2026, mm = 11] = args.month.split("-").map(Number);
      const startDate = `${args.month}-01`;
      const nextY = mm === 12 ? yy + 1 : yy;
      const nextM = mm === 12 ? 1 : mm + 1;
      const endDate = `${nextY}-${String(nextM).padStart(2, "0")}-01`;

      const segs = await db
        .select()
        .from(schema.segments)
        .where(
          and(
            gte(schema.segments.date, startDate),
            lt(schema.segments.date, endDate),
          ),
        )
        .orderBy(asc(schema.segments.startAt));

      const pts = await db
        .select({ date: schema.points.date, id: schema.points.id })
        .from(schema.points)
        .where(
          and(
            gte(schema.points.date, startDate),
            lt(schema.points.date, endDate),
          ),
        );
      const photoRows = await db
        .select({ id: schema.photos.id })
        .from(schema.photos)
        .where(
          and(
            gte(schema.photos.date, startDate),
            lt(schema.photos.date, endDate),
          ),
        );
      const noteRows = await db
        .select({ id: schema.notes.id })
        .from(schema.notes)
        .where(
          and(
            gte(schema.notes.date, startDate),
            lt(schema.notes.date, endDate),
          ),
        );

      const places = await db.select().from(schema.namedPlaces);
      const displayNameFor = (s: (typeof segs)[number]): string | null => {
        if (s.placeName) return s.placeName;
        for (const place of places) {
          if (haversineM(s.lat, s.lng, place.lat, place.lng) <= place.radiusM) {
            return place.name;
          }
        }
        return s.address ?? null;
      };

      const stays = segs.filter((s) => s.kind === "stay");
      const moves = segs.filter((s) => s.kind === "move");
      const totalDistanceM = Math.round(
        moves.reduce((sum, m) => sum + (m.distanceM ?? 0), 0),
      );

      // Daily breakdown
      const dailyMap = new Map<
        string,
        { date: string; stayCount: number; moveCount: number; distanceM: number }
      >();
      for (const s of segs) {
        const e =
          dailyMap.get(s.date) ?? {
            date: s.date,
            stayCount: 0,
            moveCount: 0,
            distanceM: 0,
          };
        if (s.kind === "stay") e.stayCount += 1;
        else {
          e.moveCount += 1;
          e.distanceM += s.distanceM ?? 0;
        }
        dailyMap.set(s.date, e);
      }
      for (const p of pts) {
        if (!dailyMap.has(p.date)) {
          dailyMap.set(p.date, {
            date: p.date,
            stayCount: 0,
            moveCount: 0,
            distanceM: 0,
          });
        }
      }
      const daily = [...dailyMap.values()]
        .map((d) => ({ ...d, distanceM: Math.round(d.distanceM) }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const activeDays = daily.length;

      // Top places: group stays by display name + proximity cluster.
      // Use name as primary key when available; otherwise cluster by
      // 200m around first stay in group.
      type PlaceGroup = {
        name: string;
        lat: number;
        lng: number;
        visitCount: number;
        totalMinutes: number;
        firstDate: string;
        stays: (typeof segs)[number][];
      };
      const groups: PlaceGroup[] = [];
      for (const stay of stays) {
        const name =
          displayNameFor(stay) ??
          `${stay.lat.toFixed(3)}, ${stay.lng.toFixed(3)}`;
        let found: PlaceGroup | undefined;
        for (const g of groups) {
          if (g.name === name) {
            found = g;
            break;
          }
          if (
            !stay.placeName &&
            !stay.address &&
            haversineM(g.lat, g.lng, stay.lat, stay.lng) <= STAY_RADIUS_M
          ) {
            found = g;
            break;
          }
        }
        const minutes = Math.max(
          0,
          Math.round((stay.endAt - stay.startAt) / 60000),
        );
        if (found) {
          found.visitCount += 1;
          found.totalMinutes += minutes;
          found.stays.push(stay);
          if (stay.date < found.firstDate) found.firstDate = stay.date;
          // keep centroid roughly updated
          found.lat = (found.lat * (found.visitCount - 1) + stay.lat) / found.visitCount;
          found.lng = (found.lng * (found.visitCount - 1) + stay.lng) / found.visitCount;
        } else {
          groups.push({
            name,
            lat: stay.lat,
            lng: stay.lng,
            visitCount: 1,
            totalMinutes: minutes,
            firstDate: stay.date,
            stays: [stay],
          });
        }
      }
      const topPlaces = [...groups]
        .sort((a, b) => b.visitCount - a.visitCount || b.totalMinutes - a.totalMinutes)
        .slice(0, 8)
        .map((g) => ({
          name: g.name,
          lat: g.lat,
          lng: g.lng,
          visitCount: g.visitCount,
          totalMinutes: g.totalMinutes,
        }));

      // Activities breakdown
      const actMap = new Map<
        string,
        { type: string | null; count: number; distanceM: number }
      >();
      for (const m of moves) {
        const key = m.activityType ?? "__null__";
        const e = actMap.get(key) ?? {
          type: m.activityType,
          count: 0,
          distanceM: 0,
        };
        e.count += 1;
        e.distanceM += m.distanceM ?? 0;
        actMap.set(key, e);
      }
      const activities = [...actMap.values()]
        .map((a) => ({ ...a, distanceM: Math.round(a.distanceM) }))
        .sort((a, b) => b.distanceM - a.distanceM);

      // First-time places: groups whose location/name never appeared before this month
      let firstTimePlaces: {
        name: string;
        lat: number;
        lng: number;
        firstDate: string;
      }[] = [];
      if (groups.length > 0) {
        const earlier = await db
          .select()
          .from(schema.segments)
          .where(
            and(
              eq(schema.segments.kind, "stay"),
              lt(schema.segments.date, startDate),
            ),
          );
        firstTimePlaces = groups
          .filter((g) => {
            const seenBefore = earlier.some((e) => {
              const eName =
                e.placeName ??
                (() => {
                  for (const place of places) {
                    if (
                      haversineM(e.lat, e.lng, place.lat, place.lng) <=
                      place.radiusM
                    )
                      return place.name;
                  }
                  return e.address ?? null;
                })();
              if (eName && eName === g.name) return true;
              return haversineM(e.lat, e.lng, g.lat, g.lng) <= STAY_RADIUS_M;
            });
            return !seenBefore;
          })
          .sort((a, b) => a.firstDate.localeCompare(b.firstDate))
          .slice(0, 8)
          .map((g) => ({
            name: g.name,
            lat: g.lat,
            lng: g.lng,
            firstDate: g.firstDate,
          }));
      }

      return {
        month: args.month,
        totalDistanceM,
        stayCount: stays.length,
        moveCount: moves.length,
        pointCount: pts.length,
        photoCount: photoRows.length,
        noteCount: noteRows.length,
        activeDays,
        topPlaces,
        activities,
        firstTimePlaces,
        daily,
      };
    },
  }),

  getAlbum: defineAction({
    description:
      "Returns all stay photos for the album view, newest first, with resolved place labels.",
    request: z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
    }),
    response: z.object({
      photos: z.array(
        z.object({
          id: z.number(),
          date: z.string(),
          url: z.string(),
          caption: z.string().nullable(),
          lat: z.number(),
          lng: z.number(),
          placeName: z.string().nullable(),
          address: z.string().nullable(),
        }),
      ),
      total: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db
        .select()
        .from(schema.photos)
        .orderBy(asc(schema.photos.date));
      rows = [...rows].reverse();
      if (args.month) {
        rows = rows.filter((r) => r.date.startsWith(args.month!));
      }
      const places = await db.select().from(schema.namedPlaces);
      const allStays = await db
        .select()
        .from(schema.segments)
        .where(eq(schema.segments.kind, "stay"));
      const allPoints = await db.select().from(schema.points);

      const photos: {
        id: number;
        date: string;
        url: string;
        caption: string | null;
        lat: number;
        lng: number;
        placeName: string | null;
        address: string | null;
      }[] = [];
      for (const photo of rows) {
        // Nearest stay on same date within radius gives the best label
        let bestStay: (typeof allStays)[number] | null = null;
        let bestDist = Infinity;
        for (const s of allStays) {
          if (s.date !== photo.date) continue;
          const d = haversineM(s.lat, s.lng, photo.lat, photo.lng);
          if (d <= STAY_RADIUS_M && d < bestDist) {
            bestDist = d;
            bestStay = s;
          }
        }
        let placeName: string | null = bestStay?.placeName ?? null;
        let address: string | null = bestStay?.address ?? null;
        if (!address) {
          // Provisional stays have no stored segment; fall back to the
          // nearest point's address label on the same date.
          let bestPointDist = Infinity;
          for (const p of allPoints) {
            if (p.date !== photo.date || !p.addressLabel) continue;
            const d = haversineM(p.lat, p.lng, photo.lat, photo.lng);
            if (d <= STAY_RADIUS_M && d < bestPointDist) {
              bestPointDist = d;
              address = p.addressLabel;
            }
          }
        }
        if (!placeName) {
          for (const place of places) {
            if (
              haversineM(photo.lat, photo.lng, place.lat, place.lng) <=
              place.radiusM
            ) {
              placeName = place.name;
              break;
            }
          }
        }
        photos.push({
          id: photo.id,
          date: photo.date,
          url: await ctx.blobs.getUrl(photo.blobKey),
          caption: photo.caption,
          lat: photo.lat,
          lng: photo.lng,
          placeName,
          address,
        });
      }
      return { photos, total: photos.length };
    },
  }),
} satisfies ActionsModule;
