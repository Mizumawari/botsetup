// Parser for Google Timeline export files. Four shapes are supported:
//
// 1. iOS on-device export (`location-history.json`): a bare array of
//    segments; coordinates are "geo:lat,lng" strings; numbers may be strings.
// 2. Android on-device export (`Timeline.json`): root object with
//    `semanticSegments` / `rawSignals` / `userLocationProfile`; coordinates
//    are "lat°, lng°" strings.
// 3. Legacy Takeout semantic history: root object with `timelineObjects`
//    (placeVisit / activitySegment, E7 coordinates, place names/addresses).
// 4. Legacy Takeout `Records.json`: root object with `locations`
//    (latitudeE7/longitudeE7 + timestamp).
//
// Visits and activities become segments (stored verbatim server-side);
// breadcrumbs and raw positions become thinned points.

export interface ParsedSegment {
  kind: "stay" | "move";
  startAt: number;
  endAt: number;
  lat: number;
  lng: number;
  endLat?: number | null;
  endLng?: number | null;
  placeName?: string | null;
  address?: string | null;
  distanceM?: number | null;
  activityType?: string | null;
  semanticType?: string | null;
}

export interface ParsedPoint {
  capturedAt: number;
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

export interface FrequentPlace {
  semanticType: string;
  lat: number;
  lng: number;
}

export interface ParseResult {
  format: string;
  segments: ParsedSegment[];
  points: ParsedPoint[];
  frequentPlaces: FrequentPlace[];
}

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null
    ? (value as Rec)
    : null;
}

function asArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
    // Unix seconds vs milliseconds heuristic.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (value.trim() !== "" && Number.isFinite(asNumber)) {
      return asNumber < 1e12
        ? Math.round(asNumber * 1000)
        : Math.round(asNumber);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Parses "geo:35.0,139.0", "35.0°, 139.0°", or "35.0,139.0". */
function parseCoordString(raw: string): { lat: number; lng: number } | null {
  const cleaned = raw.replace(/^geo:/i, "").replace(/°/g, "").trim();
  const parts = cleaned.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 2) return null;
  const [lat, lng] = parts;
  if (lat === undefined || lng === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Accepts the many latLng encodings Google uses across export dialects. */
function coordOf(value: unknown): { lat: number; lng: number } | null {
  if (typeof value === "string") return parseCoordString(value);
  const rec = asRec(value);
  if (!rec) return null;
  const nested = rec["latLng"] ?? rec["LatLng"];
  if (nested !== undefined) {
    const fromNested = coordOf(nested);
    if (fromNested) return fromNested;
  }
  const latDirect = asNum(rec["latitude"]) ?? asNum(rec["lat"]);
  const latE7 = asNum(rec["latitudeE7"]);
  const lat = latDirect ?? (latE7 !== null ? latE7 / 1e7 : null);
  const lngDirect = asNum(rec["longitude"]) ?? asNum(rec["lng"]);
  const lngE7 = asNum(rec["longitudeE7"]);
  const lng = lngDirect ?? (lngE7 !== null ? lngE7 / 1e7 : null);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function e7Coord(rec: Rec): { lat: number; lng: number } | null {
  const latE7 = asNum(rec["latitudeE7"]);
  const lngE7 = asNum(rec["longitudeE7"]);
  if (latE7 === null || lngE7 === null) return null;
  return { lat: latE7 / 1e7, lng: lngE7 / 1e7 };
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

function thinPoints(points: ParsedPoint[]): ParsedPoint[] {
  const sorted = [...points].sort((a, b) => a.capturedAt - b.capturedAt);
  const kept: ParsedPoint[] = [];
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

/** "walking" / "in passenger vehicle" -> "WALKING" / "IN_PASSENGER_VEHICLE". */
function normalizeActivityType(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/** One segment of the on-device dialects (iOS array / Android semanticSegments). */
function parseSemanticSegment(
  raw: unknown,
  segments: ParsedSegment[],
  points: ParsedPoint[],
): void {
  const seg = asRec(raw);
  if (!seg) return;
  const startAt = parseTime(seg["startTime"]);
  const endAt = parseTime(seg["endTime"]);
  if (startAt === null || endAt === null) return;

  const visit = asRec(seg["visit"]);
  if (visit) {
    const candidate =
      asRec(visit["topCandidate"]) ?? (visit["placeLocation"] || visit["placeID"] || visit["placeId"] ? visit : null);
    if (candidate) {
      const coord =
        coordOf(candidate["placeLocation"]) ??
        coordOf(visit["placeLocation"]);
      if (coord) {
        segments.push({
          kind: "stay",
          startAt,
          endAt,
          lat: coord.lat,
          lng: coord.lng,
          semanticType:
            asStr(candidate["semanticType"]) ?? asStr(visit["semanticType"]),
        });
        return;
      }
    }
  }

  const activity = asRec(seg["activity"]);
  if (activity) {
    const startCoord = coordOf(activity["start"]);
    const endCoord = coordOf(activity["end"]);
    if (startCoord && endCoord) {
      const candidate = asRec(activity["topCandidate"]);
      const rawType = candidate ? asStr(candidate["type"]) : null;
      segments.push({
        kind: "move",
        startAt,
        endAt,
        lat: startCoord.lat,
        lng: startCoord.lng,
        endLat: endCoord.lat,
        endLng: endCoord.lng,
        distanceM: asNum(activity["distanceMeters"]),
        activityType: rawType ? normalizeActivityType(rawType) : null,
      });
      return;
    }
  }

  const path = asArr(seg["timelinePath"]);
  for (const entryRaw of path) {
    const entry = asRec(entryRaw);
    if (!entry) continue;
    const coord = coordOf(entry["point"]);
    if (!coord) continue;
    // iOS dialect: the offset from the segment start in minutes, either as
    // `durationMinutesOffsetFromStartTime` (string) or as a numeric `time`.
    // A string `time` may also be an absolute timestamp in other dialects.
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
    points.push({ capturedAt, lat: coord.lat, lng: coord.lng });
  }
}

function parseTakeoutObject(
  raw: unknown,
  segments: ParsedSegment[],
): void {
  const obj = asRec(raw);
  if (!obj) return;

  const visit = asRec(obj["placeVisit"]);
  if (visit) {
    const location = asRec(visit["location"]);
    const duration = asRec(visit["duration"]);
    if (location && duration) {
      const coord = e7Coord(location) ?? coordOf(location);
      const startAt = parseTime(duration["startTimestamp"]);
      const endAt = parseTime(duration["endTimestamp"]);
      if (coord && startAt !== null && endAt !== null) {
        segments.push({
          kind: "stay",
          startAt,
          endAt,
          lat: coord.lat,
          lng: coord.lng,
          placeName: asStr(location["name"]),
          address: asStr(location["address"]),
          semanticType: asStr(location["semanticType"]),
        });
      }
    }
    return;
  }

  const activity = asRec(obj["activitySegment"]);
  if (activity) {
    const duration = asRec(activity["duration"]);
    const startLocation = asRec(activity["startLocation"]);
    const endLocation = asRec(activity["endLocation"]);
    if (duration && startLocation && endLocation) {
      const startCoord = e7Coord(startLocation) ?? coordOf(startLocation);
      const endCoord = e7Coord(endLocation) ?? coordOf(endLocation);
      const startAt = parseTime(duration["startTimestamp"]);
      const endAt = parseTime(duration["endTimestamp"]);
      if (startCoord && endCoord && startAt !== null && endAt !== null) {
        segments.push({
          kind: "move",
          startAt,
          endAt,
          lat: startCoord.lat,
          lng: startCoord.lng,
          endLat: endCoord.lat,
          endLng: endCoord.lng,
          distanceM: asNum(activity["distance"]),
          activityType: (() => {
            const t = asStr(activity["activityType"]);
            return t ? normalizeActivityType(t) : null;
          })(),
        });
      }
    }
  }
}

export function parseTimelineExport(text: string): ParseResult {
  const root: unknown = JSON.parse(text);
  const segments: ParsedSegment[] = [];
  const rawPoints: ParsedPoint[] = [];
  const frequentPlaces: FrequentPlace[] = [];

  // iOS dialect: bare array of segments.
  if (Array.isArray(root)) {
    for (const item of root) parseSemanticSegment(item, segments, rawPoints);
    return {
      format: "iOS タイムライン書き出し",
      segments,
      points: thinPoints(rawPoints),
      frequentPlaces,
    };
  }

  const rootRec = asRec(root);
  if (!rootRec) {
    throw new Error("JSONの形式を認識できませんでした");
  }

  if (Array.isArray(rootRec["semanticSegments"])) {
    for (const item of asArr(rootRec["semanticSegments"])) {
      parseSemanticSegment(item, segments, rawPoints);
    }
    for (const signalRaw of asArr(rootRec["rawSignals"])) {
      const signal = asRec(signalRaw);
      const position = signal ? asRec(signal["position"]) : null;
      if (!position) continue;
      const coord = coordOf(position["LatLng"] ?? position["latLng"]);
      const capturedAt = parseTime(position["timestamp"]);
      if (coord && capturedAt !== null) {
        rawPoints.push({
          capturedAt,
          lat: coord.lat,
          lng: coord.lng,
          accuracyM: asNum(position["accuracyMeters"]),
        });
      }
    }
    const profile = asRec(rootRec["userLocationProfile"]);
    for (const placeRaw of asArr(profile?.["frequentPlaces"])) {
      const place = asRec(placeRaw);
      if (!place) continue;
      const coord = coordOf(place["placeLocation"]) ?? coordOf(place);
      const semanticType = asStr(place["semanticType"]);
      if (coord && semanticType) {
        frequentPlaces.push({ semanticType, lat: coord.lat, lng: coord.lng });
      }
    }
    return {
      format: "Android タイムライン書き出し",
      segments,
      points: thinPoints(rawPoints),
      frequentPlaces,
    };
  }

  if (Array.isArray(rootRec["timelineObjects"])) {
    for (const item of asArr(rootRec["timelineObjects"])) {
      parseTakeoutObject(item, segments);
    }
    return {
      format: "Google Takeout（セマンティック履歴）",
      segments,
      points: [],
      frequentPlaces,
    };
  }

  if (Array.isArray(rootRec["locations"])) {
    for (const locRaw of asArr(rootRec["locations"])) {
      const loc = asRec(locRaw);
      if (!loc) continue;
      const coord = e7Coord(loc);
      const capturedAt =
        parseTime(loc["timestamp"]) ?? parseTime(loc["timestampMs"]);
      if (coord && capturedAt !== null) {
        rawPoints.push({
          capturedAt,
          lat: coord.lat,
          lng: coord.lng,
          accuracyM: asNum(loc["accuracy"]),
        });
      }
    }
    return {
      format: "Google Takeout（Records.json）",
      segments: [],
      points: thinPoints(rawPoints),
      frequentPlaces,
    };
  }

  throw new Error(
    "対応しているタイムライン書き出し形式ではありませんでした（iOS / Android / 旧Takeout のJSONに対応しています）",
  );
}

export function jstDateOf(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
