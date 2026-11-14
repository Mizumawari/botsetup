// Privileged host handlers for the location timeline.
//
// The only host capability the artifact needs is reading the Google
// Timeline export file the user placed in the workspace inbox
// (~/workspace/location-timeline/inbox/). Actions cannot touch the local
// filesystem, so `importInboxTimeline` calls `readTimelineInboxChunk`
// through ctx.executePrivileged and does all DB work itself.
//
// The handler parses one slice of the iOS on-device export (a bare JSON
// array of visit / activity / timelinePath entries) into flat rows:
// visits and activities become segment rows; timelinePath breadcrumbs
// become points, with their per-entry minute offsets
// (`durationMinutesOffsetFromStartTime`) resolved to absolute instants.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  definePrivilegedContracts,
  definePrivilegedHandlers,
  z,
} from "@hatch/space-sdk";

// NOTE: the contract spec must be fully inline — the build extracts this
// object verbatim into server/.generated/privileged.contract.ts, so it
// cannot reference local constants.
export const privileged = definePrivilegedContracts({
  readTimelineInboxChunk: {
    request: z.object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(1000),
    }),
    response: z.object({
      fileName: z.string(),
      total: z.number().int(),
      items: z.array(
        z.object({
          startAt: z.number(),
          endAt: z.number(),
          visitLat: z.number().nullable(),
          visitLng: z.number().nullable(),
          semanticType: z.string().nullable(),
          actStartLat: z.number().nullable(),
          actStartLng: z.number().nullable(),
          actEndLat: z.number().nullable(),
          actEndLng: z.number().nullable(),
          distanceM: z.number().nullable(),
          activityType: z.string().nullable(),
          path: z.array(
            z.object({
              capturedAt: z.number(),
              lat: z.number(),
              lng: z.number(),
            }),
          ),
        }),
      ),
    }),
  },
});

interface ChunkItem {
  startAt: number;
  endAt: number;
  visitLat: number | null;
  visitLng: number | null;
  semanticType: string | null;
  actStartLat: number | null;
  actStartLng: number | null;
  actEndLat: number | null;
  actEndLng: number | null;
  distanceM: number | null;
  activityType: string | null;
  path: { capturedAt: number; lat: number; lng: number }[];
}

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null
    ? (value as Rec)
    : null;
}

function asNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Parses "geo:35.0,139.0" style coordinate strings. */
function parseCoordString(raw: unknown): { lat: number; lng: number } | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/^geo:/i, "").replace(/°/g, "").trim();
  const parts = cleaned.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 2) return null;
  const [lat, lng] = parts;
  if (lat === undefined || lng === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** "walking" / "in passenger vehicle" -> "WALKING" / "IN_PASSENGER_VEHICLE". */
function normalizeActivityType(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function parseEntry(raw: unknown): ChunkItem | null {
  const seg = asRec(raw);
  if (!seg) return null;
  const startAt = parseTime(seg["startTime"]);
  const endAt = parseTime(seg["endTime"]);
  if (startAt === null || endAt === null) return null;
  const item: ChunkItem = {
    startAt,
    endAt,
    visitLat: null,
    visitLng: null,
    semanticType: null,
    actStartLat: null,
    actStartLng: null,
    actEndLat: null,
    actEndLng: null,
    distanceM: null,
    activityType: null,
    path: [],
  };

  const visit = asRec(seg["visit"]);
  if (visit) {
    const candidate = asRec(visit["topCandidate"]) ?? visit;
    const coord = parseCoordString(candidate["placeLocation"]);
    if (coord) {
      item.visitLat = coord.lat;
      item.visitLng = coord.lng;
      item.semanticType =
        asStr(candidate["semanticType"]) ?? asStr(visit["semanticType"]);
      return item;
    }
  }

  const activity = asRec(seg["activity"]);
  if (activity) {
    const startCoord = parseCoordString(activity["start"]);
    const endCoord = parseCoordString(activity["end"]);
    if (startCoord && endCoord) {
      item.actStartLat = startCoord.lat;
      item.actStartLng = startCoord.lng;
      item.actEndLat = endCoord.lat;
      item.actEndLng = endCoord.lng;
      item.distanceM = asNum(activity["distanceMeters"]);
      const candidate = asRec(activity["topCandidate"]);
      const rawType = candidate ? asStr(candidate["type"]) : null;
      item.activityType = rawType ? normalizeActivityType(rawType) : null;
      return item;
    }
  }

  if (Array.isArray(seg["timelinePath"])) {
    for (const entryRaw of seg["timelinePath"]) {
      const entry = asRec(entryRaw);
      if (!entry) continue;
      const coord = parseCoordString(entry["point"]);
      if (!coord) continue;
      // iOS exports carry the offset from the segment start, either as
      // `durationMinutesOffsetFromStartTime` (string minutes) or as a
      // numeric `time` (minutes). A string `time` may also be an absolute
      // timestamp in other dialects.
      let capturedAt: number | null = null;
      const offsetMin =
        asNum(entry["durationMinutesOffsetFromStartTime"]) ??
        (typeof entry["time"] === "number" ? entry["time"] : null) ??
        (typeof entry["time"] === "string" &&
        entry["time"].trim() !== "" &&
        Number.isFinite(Number(entry["time"])) &&
        Number(entry["time"]) < 100000
          ? Number(entry["time"])
          : null);
      if (offsetMin !== null) {
        capturedAt = startAt + Math.round(offsetMin * 60 * 1000);
      } else if (entry["time"] !== undefined) {
        capturedAt = parseTime(entry["time"]);
      }
      if (capturedAt === null) continue;
      item.path.push({ capturedAt, lat: coord.lat, lng: coord.lng });
    }
    return item;
  }

  return item;
}

const INBOX_FILE = "google-timeline-2026-11-14.json";

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async readTimelineInboxChunk(args: { offset: number; limit: number }) {
    const filePath = join(
      homedir(),
      "workspace",
      "location-timeline",
      "inbox",
      INBOX_FILE,
    );
    const text = await readFile(filePath, "utf8");
    const root: unknown = JSON.parse(text);
    if (!Array.isArray(root)) {
      throw new Error("inbox timeline file is not a JSON array");
    }
    const items: ChunkItem[] = [];
    for (const raw of root.slice(args.offset, args.offset + args.limit)) {
      const item = parseEntry(raw);
      if (item) items.push(item);
    }
    return { fileName: INBOX_FILE, total: root.length, items };
  },
});
