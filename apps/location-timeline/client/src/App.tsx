import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { mountPlaceListMap } from "./map_helpers.mjs";
import {
jstDateOf,
parseTimelineExport,
type ParseResult,
} from "./importParser";

type DayData = ApiResponse<typeof api, "getDay">;
type DaySegment = DayData["segments"][number];

const ACTIVITY_LABELS: Record<string, string> = {
  WALKING: "徒歩",
  CYCLING: "自転車",
  RUNNING: "ランニング",
  IN_PASSENGER_VEHICLE: "車",
  IN_TRAIN: "電車",
  IN_BUS: "バス",
  IN_SUBWAY: "地下鉄",
  IN_TRAM: "路面電車",
  IN_FERRY: "船",
  IN_TAXI: "タクシー",
  MOTORCYCLING: "バイク",
  FLYING: "飛行機",
  STILL: "滞在",
  UNKNOWN: "移動",
};

const timeFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const weekdayFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  weekday: "short",
});
const monthDayFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
});

function fmtTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

function fmtDuration(startIso: string, endIso: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000),
  );
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

function fmtDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

// Downscale a picked photo to at most 1600px on the long side and re-encode
// as JPEG, so uploads stay small enough for one action call.
async function fileToPhotoPayload(
  file: File,
): Promise<{ dataBase64: string; mimeType: "image/jpeg" }> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image load failed"));
      el.src = objectUrl;
    });
    const maxSide = 1600;
    const scale = Math.min(
      1,
      maxSide / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) throw new Error("canvas unavailable");
    ctx2d.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const base64 = dataUrl.split(",")[1];
    if (!base64) throw new Error("encode failed");
    return { dataBase64: base64, mimeType: "image/jpeg" as const };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function shiftDate(date: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function shiftMonth(date: string, delta: number): string {
  const [y = 2026, m = 11] = date.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(total: number): string {
  if (total < 60) return `${total}分`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${h}時間` : `${h}時間${rest}分`;
}

function monthLabel(month: string): string {
  const [y = 2026, m = 11] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

function activityLabel(type: string | null): string {
  if (!type) return "移動";
  return ACTIVITY_LABELS[type] ?? "移動";
}

interface PlaceForMap {
  label: string;
  address?: string;
  lat: number;
  lng: number;
}

function DayMap({
  places,
  getRows,
  mapKey,
}: {
  places: PlaceForMap[];
  getRows: () => (HTMLElement | null)[];
  mapKey: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUnavailable(false);
    const el = containerRef.current;
    if (!el || places.length === 0) return;
    const rows = getRows().filter(
      (r): r is HTMLElement => r !== null,
    );
    if (rows.length !== places.length) return;
    const handle = mountPlaceListMap(
      el,
      { places, rows },
      () => setUnavailable(true),
    );
    if (handle === null) setUnavailable(true);
    // The map control owns its DOM node; React replaces the node via key
    // when the day or its stays change, so there is nothing to tear down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey]);

  if (places.length === 0 || unavailable) return null;
  return (
    <div
      key={mapKey}
      ref={containerRef}
      role="img"
      aria-label="その日の滞在場所の地図"
      className="h-[260px] w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
    />
  );
}

type DayPhoto = DaySegment["photos"][number];

function PhotoThumb({
  photo,
  alt,
  onDelete,
  disabled,
}: {
  photo: DayPhoto;
  alt: string;
  onDelete: () => void;
  disabled: boolean;
}) {
  return (
    <div className="relative">
      <a href={photo.url} target="_blank" rel="noreferrer">
        <img
          src={photo.url}
          alt={photo.caption ?? alt}
          loading="lazy"
          className="h-24 w-24 rounded-lg border border-[var(--border)] object-cover"
        />
      </a>
      <button
        type="button"
        aria-label="この写真を削除"
        disabled={disabled}
        onClick={onDelete}
        className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-sm leading-none text-white disabled:opacity-50"
      >
        ×
      </button>
    </div>
  );
}

function ImportPanel() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => {
    if (!parsed) return null;
    const times = [
      ...parsed.segments.map((s) => s.startAt),
      ...parsed.points.map((p) => p.capturedAt),
    ];
    if (times.length === 0) return null;
    return {
      first: jstDateOf(Math.min(...times)),
      last: jstDateOf(Math.max(...times)),
    };
  }, [parsed]);

  const onFile = async (file: File) => {
    setBusy(true);
    setStatus("ファイルを読み込んでいます…");
    setParsed(null);
    try {
      const text = await file.text();
      const result = parseTimelineExport(text);
      if (result.segments.length === 0 && result.points.length === 0) {
        setStatus("このファイルからは読み取れる記録がありませんでした。");
        return;
      }
      setFileName(file.name);
      setParsed(result);
      setStatus(null);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "ファイルの読み込みに失敗しました。",
      );
    } finally {
      setBusy(false);
    }
  };

  const runInboxImport = async () => {
    setBusy(true);
    setStatus(
      "置いてある書き出しファイルを取り込んでいます…（数分かかることがあります）",
    );
    try {
      const res = await api.importInboxTimeline({});
      setStatus(
        res.alreadyImported
          ? `このファイルは取り込み済みです：滞在・移動 ${res.segmentCount} 件、位置ポイント ${res.pointCount} 件（${res.firstDate} 〜 ${res.lastDate}）。`
          : `取り込みました：滞在・移動 ${res.segmentsAdded} 件、位置ポイント ${res.pointsAdded} 件（${res.firstDate} 〜 ${res.lastDate}）。`,
      );
      void queryClient.invalidateQueries();
    } catch {
      setStatus(
        "取り込みに失敗しました。途中まで取り込まれた分は残っています。もう一度実行すると続きから進みます。",
      );
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!parsed || !range) return;
    setBusy(true);
    let addedSegments = 0;
    let addedPoints = 0;
    try {
      for (let i = 0; i < parsed.segments.length; i += 500) {
        const batch = parsed.segments.slice(i, i + 500);
        setStatus(
          `取り込み中… 滞在・移動 ${Math.min(i + 500, parsed.segments.length)} / ${parsed.segments.length} 件`,
        );
        const res = await api.importSegments({
          fileName,
          format: parsed.format,
          segments: batch.map((s) => ({
            kind: s.kind,
            startAt: s.startAt,
            endAt: s.endAt,
            lat: s.lat,
            lng: s.lng,
            endLat: s.endLat ?? null,
            endLng: s.endLng ?? null,
            placeName: s.placeName ?? null,
            address: s.address ?? null,
            distanceM: s.distanceM ?? null,
            activityType: s.activityType ?? null,
            semanticType: s.semanticType ?? null,
          })),
        });
        addedSegments += res.added;
      }
      for (let i = 0; i < parsed.points.length; i += 2000) {
        const batch = parsed.points.slice(i, i + 2000);
        setStatus(
          `取り込み中… 位置ポイント ${Math.min(i + 2000, parsed.points.length)} / ${parsed.points.length} 件`,
        );
        const res = await api.importPoints({
          points: batch.map((p) => ({
            capturedAt: p.capturedAt,
            lat: p.lat,
            lng: p.lng,
            accuracyM: p.accuracyM ?? null,
          })),
        });
        addedPoints += res.added;
      }
      for (const place of parsed.frequentPlaces) {
        const upper = place.semanticType.toUpperCase();
        const name =
          upper === "HOME" ? "自宅" : upper === "WORK" ? "職場" : null;
        if (name) {
          await api.registerNamedPlace({ name, lat: place.lat, lng: place.lng });
        }
      }
      await api.finishImport({
        fileName,
        format: parsed.format,
        segmentCount: addedSegments,
        pointCount: addedPoints,
        firstDate: range.first,
        lastDate: range.last,
      });
      setStatus(
        `取り込みました：滞在・移動 ${addedSegments} 件、位置ポイント ${addedPoints} 件（${range.first} 〜 ${range.last}）。重複した分は自動で省かれています。`,
      );
      setParsed(null);
      void queryClient.invalidateQueries();
    } catch {
      setStatus(
        "取り込みの途中で失敗しました。途中まで取り込まれた分は残っています。もう一度実行すると、残りだけが追加されます。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="過去のタイムラインを取り込む" className="mt-10">
      <h2 className="font-serif text-lg text-[var(--text)]">
        過去の取り込み
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
        Googleマップのタイムラインはスマホの中に保存されているため、書き出したJSONファイルから取り込みます。iPhoneの場合は
        Googleマップ アプリ → プロフィール写真 → タイムライン →「…」→
        タイムラインをエクスポート、で作れます。旧Google
        Takeoutのファイル（セマンティック履歴 / Records.json）にも対応しています。
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        aria-label="タイムラインのJSONファイルを選ぶ"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
          e.target.value = "";
        }}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="min-h-11 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-white disabled:opacity-50"
        >
          書き出しファイルを選ぶ
        </button>
        {parsed && range && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runImport()}
            className="min-h-11 rounded-full border border-[var(--accent)] px-5 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
          >
            この内容を取り込む
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void runInboxImport()}
          className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 text-sm disabled:opacity-50"
        >
          置いてある書き出しファイルを取り込む
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
        Museに渡してある書き出しファイル（2024年12月〜2026年11月分）は、上のボタンからも取り込めます。取り込み済みの場合はその旨が表示され、二重には入りません。
      </p>
      {parsed && range && (
        <p className="mt-3 text-sm text-[var(--text)]">
          {fileName}：{parsed.format}／滞在・移動 {parsed.segments.length}{" "}
          件、位置ポイント {parsed.points.length} 件／期間 {range.first} 〜{" "}
          {range.last}
        </p>
      )}
      {status && (
        <p role="status" className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
          {status}
        </p>
      )}
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const today = jstDateOf(Date.now());
  const [date, setDate] = useState(today);
  const [renaming, setRenaming] = useState<DaySegment | null>(null);
  const [renameText, setRenameText] = useState("");
  const [registerPlace, setRegisterPlace] = useState(true);
  const [captureNote, setCaptureNote] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [photoTarget, setPhotoTarget] = useState<DaySegment | null>(null);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [dayNoteText, setDayNoteText] = useState("");
  const [noteTarget, setNoteTarget] = useState<DaySegment | null>(null);
  const [stayNoteText, setStayNoteText] = useState("");
  const [view, setView] = useState<"day" | "month" | "album">("day");
  const [albumMonth, setAlbumMonth] = useState<string | null>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);

  const day = useQuery({
    queryKey: ["day", date],
    queryFn: () => api.getDay({ date }),
  });
  const daysIndex = useQuery({
    queryKey: ["days"],
    queryFn: () => api.listDays({}),
  });
  const imports = useQuery({
    queryKey: ["imports"],
    queryFn: () => api.getImports({}),
  });
  const namedPlaces = useQuery({
    queryKey: ["namedPlaces"],
    queryFn: () => api.getNamedPlaces({}),
  });
  const currentMonth = date.slice(0, 7);
  const monthSummary = useQuery({
    queryKey: ["monthSummary", currentMonth],
    queryFn: () => api.getMonthSummary({ month: currentMonth }),
    enabled: view === "month",
  });
  const album = useQuery({
    queryKey: ["album"],
    queryFn: () => api.getAlbum({}),
    enabled: view === "album",
  });

  const capture = useMutation({
    mutationFn: async () => await api.captureNow({}),
    onSuccess: (res) => {
      setCaptureNote(
        res.started
          ? "現在地の取り込みを依頼しました。数十秒〜数分で、このページに反映されます。"
          : "取り込みを開始できませんでした。少し待ってからもう一度試してください。",
      );
    },
    onError: () =>
      setCaptureNote("取り込みを開始できませんでした。通信状態を確認してください。"),
  });

  const recordBrowser = useMutation({
    mutationFn: async (args: {
      lat: number;
      lng: number;
      accuracyM: number | null;
    }) => await api.recordPoint(args),
    onSuccess: (res) => {
      setCaptureNote("この端末の現在地を記録しました。");
      setDate(res.date);
      void queryClient.invalidateQueries();
    },
    onError: () => setCaptureNote("位置を記録できませんでした。"),
  });

  const rename = useMutation({
    mutationFn: async () => {
      if (!renaming) throw new Error("no segment");
      return await api.renameStay({
        segmentId: renaming.id,
        name: renameText.trim(),
        registerAsPlace: registerPlace,
      });
    },
    onSuccess: () => {
      setRenaming(null);
      setRenameText("");
      void queryClient.invalidateQueries();
    },
  });

  const deletePlace = useMutation({
    mutationFn: async (id: number) => await api.deleteNamedPlace({ id }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const deleteImport = useMutation({
    mutationFn: async (id: number) => await api.deleteImport({ id }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const deletePhoto = useMutation({
    mutationFn: async (id: number) => await api.deletePhoto({ id }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const addDayNote = useMutation({
    mutationFn: async () =>
      await api.addNote({ date, text: dayNoteText.trim() }),
    onSuccess: () => {
      setDayNoteText("");
      void queryClient.invalidateQueries();
    },
  });

  const addStayNote = useMutation({
    mutationFn: async () => {
      if (!noteTarget) throw new Error("no segment");
      return await api.addNote({
        date,
        text: stayNoteText.trim(),
        segmentId: noteTarget.id,
        lat: noteTarget.lat,
        lng: noteTarget.lng,
      });
    },
    onSuccess: () => {
      setNoteTarget(null);
      setStayNoteText("");
      void queryClient.invalidateQueries();
    },
  });

  const deleteNote = useMutation({
    mutationFn: async (id: number) => await api.deleteNote({ id }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const onPhotoFiles = async (files: FileList) => {
    const target = photoTarget;
    if (!target) return;
    setPhotoBusy(true);
    setPhotoNote("写真を送信しています…");
    let added = 0;
    try {
      for (const file of Array.from(files)) {
        const payload = await fileToPhotoPayload(file);
        await api.addPhoto({
          date,
          segmentId: target.id,
          lat: target.lat,
          lng: target.lng,
          dataBase64: payload.dataBase64,
          mimeType: payload.mimeType,
        });
        added += 1;
      }
      setPhotoNote(
        added > 0 ? `写真を ${added} 枚追加しました。` : null,
      );
      void queryClient.invalidateQueries();
    } catch {
      setPhotoNote(
        added > 0
          ? `${added} 枚は追加しましたが、途中で失敗しました。`
          : "写真を追加できませんでした。この形式の画像は読み込めないことがあります。",
      );
    } finally {
      setPhotoBusy(false);
      setPhotoTarget(null);
    }
  };

  const onBrowserLocate = () => {
    if (!("geolocation" in navigator)) {
      setCaptureNote("この端末ではブラウザの位置取得が使えません。");
      return;
    }
    setCaptureNote("この端末の位置を取得しています…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        recordBrowser.mutate({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        });
      },
      () => setCaptureNote("この端末の位置を取得できませんでした。"),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const segments = day.data?.segments ?? [];
  const stays = segments.filter((s) => s.kind === "stay");
  const mapPlaces: PlaceForMap[] = stays.map((s) => ({
    label: s.placeName ?? s.address ?? "滞在",
    ...(s.address ? { address: s.address } : {}),
    lat: s.lat,
    lng: s.lng,
  }));
  const mapKey = `${date}:${stays.map((s) => s.id).join(",")}`;
  rowRefs.current = [];

  const monthDays = useMemo(() => {
    const byDate = new Map(
      (daysIndex.data?.days ?? []).map((d) => [d.date, d]),
    );
    const [y = 2026, m = 11] = date.split("-").map(Number);
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const startOffset = (firstDow + 6) % 7; // Monday start
    const cells: { date: string; inMonth: boolean }[] = [];
    const cursor = new Date(Date.UTC(y, m - 1, 1 - startOffset));
    for (let i = 0; i < 42; i++) {
      cells.push({
        date: cursor.toISOString().slice(0, 10),
        inMonth: cursor.getUTCMonth() === m - 1,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { cells, byDate };
  }, [date, daysIndex.data]);

  const selectedDateObj = new Date(`${date}T00:00:00+09:00`);
  const isToday = date === today;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-16">
        {/* Date header */}
        <header className="pt-6">
          <p className="text-sm text-[var(--dim)]">
            {isToday ? "今日" : weekdayFmt.format(selectedDateObj)}
          </p>
          <h1 className="mt-1 font-serif text-4xl leading-tight">
            {monthDayFmt.format(selectedDateObj)}
            <span className="ml-2 align-middle text-lg text-[var(--dim)]">
              {weekdayFmt.format(selectedDateObj)}曜日
            </span>
          </h1>
          {day.data && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              滞在 {day.data.summary.stayCount} 件 ・ 移動{" "}
              {day.data.summary.moveCount} 件 ・ 合計{" "}
              {fmtDistance(day.data.summary.totalDistanceM)} ・ 記録ポイント{" "}
              {day.data.summary.pointCount} 件
              {day.data.summary.provisionalCount > 0 &&
                ` ・ 確定前の記録 ${day.data.summary.provisionalCount} 件`}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label="前の日"
              onClick={() => setDate(shiftDate(date, -1))}
              className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm"
            >
              ← 前の日
            </button>
            <button
              type="button"
              aria-label="次の日"
              onClick={() => setDate(shiftDate(date, 1))}
              className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm"
            >
              次の日 →
            </button>
            {!isToday && (
              <button
                type="button"
                onClick={() => setDate(today)}
                className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm"
              >
                今日に戻る
              </button>
            )}
            <label className="flex min-h-11 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm">
              日付を選ぶ
              <input
                type="date"
                aria-label="日付を選ぶ"
                value={date}
                onChange={(e) => {
                  if (e.target.value) setDate(e.target.value);
                }}
                className="bg-transparent"
              />
            </label>
          </div>

          {/* Month strip */}
          <div
            aria-label="月のカレンダー"
            className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-[var(--dim)]">
              {["月", "火", "水", "木", "金", "土", "日"].map((w) => (
                <span key={w} className="py-1">
                  {w}
                </span>
              ))}
              {monthDays.cells.map((cell) => {
                const info = monthDays.byDate.get(cell.date);
                const selected = cell.date === date;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    aria-label={`${cell.date}${info ? `（滞在${info.stayCount}件）` : ""}`}
                    aria-current={selected ? "date" : undefined}
                    onClick={() => setDate(cell.date)}
                    className={`flex min-h-10 flex-col items-center justify-center rounded-lg text-sm ${
                      selected
                        ? "bg-[var(--accent)] font-semibold text-white"
                        : cell.inMonth
                          ? "text-[var(--text)]"
                          : "text-[var(--dim)] opacity-50"
                    }`}
                  >
                    {Number(cell.date.slice(8))}
                    <span
                      aria-hidden
                      className={`mt-0.5 h-1.5 w-1.5 rounded-full ${
                        info
                          ? selected
                            ? "bg-white"
                            : "bg-[var(--accent)]"
                          : "bg-transparent"
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Capture */}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={capture.isPending}
              onClick={() => capture.mutate()}
              className="min-h-11 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-white disabled:opacity-50"
            >
              現在地を取り込む
            </button>
            <button
              type="button"
              disabled={recordBrowser.isPending}
              onClick={onBrowserLocate}
              className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 text-sm disabled:opacity-50"
            >
              この端末の現在地を記録
            </button>
          </div>
          {captureNote && (
            <p role="status" className="mt-2 text-sm text-[var(--dim)]">
              {captureNote}
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
            位置は1時間ごとに自動でも取り込まれます。精度は滞在と移動の流れが分かる程度で、秒単位の軌跡ではありません。
          </p>
        </header>

        {/* View tabs */}
        <nav aria-label="表示切り替え" className="mt-6">
          <div className="flex rounded-full border border-[var(--border)] bg-[var(--surface)] p-1">
            {(
              [
                { key: "day", label: "日" },
                { key: "month", label: "月のまとめ" },
                { key: "album", label: "アルバム" },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={view === t.key}
                onClick={() => setView(t.key)}
                className={`min-h-10 flex-1 rounded-full text-sm font-medium transition-colors ${
                  view === t.key
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--dim)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>

        {view === "month" && (
          <section aria-label="月のまとめ" className="mt-6">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                aria-label="前の月"
                onClick={() => setDate(shiftMonth(date, -1))}
                className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm"
              >
                ← 前の月
              </button>
              <h2 className="font-serif text-2xl">
                {monthLabel(currentMonth)}
              </h2>
              <button
                type="button"
                aria-label="次の月"
                onClick={() => setDate(shiftMonth(date, 1))}
                className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm"
              >
                次の月 →
              </button>
            </div>

            {monthSummary.isPending && (
              <p className="py-10 text-center text-sm text-[var(--dim)]">
                読み込んでいます…
              </p>
            )}
            {monthSummary.error && (
              <p className="py-10 text-center text-sm text-[var(--dim)]">
                読み込みに失敗しました。
                <button
                  type="button"
                  onClick={() => void monthSummary.refetch()}
                  className="ml-2 underline"
                >
                  もう一度試す
                </button>
              </p>
            )}
            {monthSummary.data && (
              <>
                {monthSummary.data.activeDays === 0 &&
                monthSummary.data.stayCount === 0 ? (
                  <div className="mt-6 rounded-[var(--radius)] border border-dashed border-[var(--border)] px-5 py-10 text-center">
                    <p className="text-sm leading-relaxed text-[var(--dim)]">
                      この月の記録はまだありません。日表示で記録が貯まると、ここにまとめが出ます。
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {[
                        {
                          label: "総移動距離",
                          value: fmtDistance(monthSummary.data.totalDistanceM),
                        },
                        {
                          label: "記録があった日",
                          value: `${monthSummary.data.activeDays}日`,
                        },
                        {
                          label: "滞在",
                          value: `${monthSummary.data.stayCount}件`,
                        },
                        {
                          label: "移動",
                          value: `${monthSummary.data.moveCount}件`,
                        },
                        {
                          label: "写真",
                          value: `${monthSummary.data.photoCount}枚`,
                        },
                        {
                          label: "一言",
                          value: `${monthSummary.data.noteCount}件`,
                        },
                      ].map((stat) => (
                        <div
                          key={stat.label}
                          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
                        >
                          <p className="text-xs text-[var(--dim)]">
                            {stat.label}
                          </p>
                          <p className="mt-1 font-serif text-2xl leading-none">
                            {stat.value}
                          </p>
                        </div>
                      ))}
                    </div>

                    {monthSummary.data.topPlaces.length > 0 && (
                      <div className="mt-8">
                        <h3 className="font-serif text-lg">よく行った場所</h3>
                        <ol className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                          {monthSummary.data.topPlaces.map((p, i) => (
                            <li
                              key={`${p.name}-${i}`}
                              className="flex items-center justify-between gap-3 px-4 py-3"
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-white">
                                  {i + 1}
                                </span>
                                <div className="min-w-0">
                                  <p className="truncate text-base font-medium">
                                    {p.name}
                                  </p>
                                  <p className="text-xs text-[var(--dim)]">
                                    滞在合計 {fmtMinutes(p.totalMinutes)}
                                  </p>
                                </div>
                              </div>
                              <span className="shrink-0 text-sm text-[var(--dim)]">
                                {p.visitCount}回
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {monthSummary.data.firstTimePlaces.length > 0 && (
                      <div className="mt-8">
                        <h3 className="font-serif text-lg">
                          この月、初めて行った場所
                        </h3>
                        <ul className="mt-3 flex flex-wrap gap-2">
                          {monthSummary.data.firstTimePlaces.map((p, i) => (
                            <li
                              key={`${p.name}-${i}`}
                              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                            >
                              <span className="font-medium">{p.name}</span>
                              <span className="ml-2 text-xs text-[var(--dim)]">
                                {p.firstDate.slice(5).replace("-", "/")}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {monthSummary.data.activities.length > 0 && (
                      <div className="mt-8">
                        <h3 className="font-serif text-lg">移動の内訳</h3>
                        <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                          {monthSummary.data.activities.map((a, i) => (
                            <li
                              key={`${a.type ?? "unknown"}-${i}`}
                              className="flex items-center justify-between px-4 py-3 text-sm"
                            >
                              <span className="font-medium">
                                {activityLabel(a.type)}
                              </span>
                              <span className="text-[var(--dim)]">
                                {a.count}件 ・ {fmtDistance(a.distanceM)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {monthSummary.data.daily.length > 0 && (
                      <div className="mt-8">
                        <h3 className="font-serif text-lg">日ごとの記録</h3>
                        <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                          {[...monthSummary.data.daily]
                            .reverse()
                            .map((d) => (
                              <li key={d.date}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDate(d.date);
                                    setView("day");
                                  }}
                                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm"
                                >
                                  <span className="font-medium">
                                    {d.date.slice(5).replace("-", "/")}
                                    <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                                      {weekdayFmt.format(
                                        new Date(`${d.date}T00:00:00+09:00`),
                                      )}
                                    </span>
                                  </span>
                                  <span className="text-[var(--dim)]">
                                    滞在{d.stayCount} ・ 移動{d.moveCount}
                                    {d.distanceM > 0 &&
                                      ` ・ ${fmtDistance(d.distanceM)}`}
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        )}

        {view === "album" && (
          <section aria-label="写真アルバム" className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-serif text-2xl">アルバム</h2>
              {album.data && (
                <p className="text-sm text-[var(--dim)]">
                  全{album.data.total}枚
                </p>
              )}
            </div>
            {album.isPending && (
              <p className="py-10 text-center text-sm text-[var(--dim)]">
                読み込んでいます…
              </p>
            )}
            {album.error && (
              <p className="py-10 text-center text-sm text-[var(--dim)]">
                読み込みに失敗しました。
                <button
                  type="button"
                  onClick={() => void album.refetch()}
                  className="ml-2 underline"
                >
                  もう一度試す
                </button>
              </p>
            )}
            {album.data && album.data.total === 0 && (
              <div className="mt-6 rounded-[var(--radius)] border border-dashed border-[var(--border)] px-5 py-10 text-center">
                <p className="text-sm leading-relaxed text-[var(--dim)]">
                  まだ写真がありません。日のタイムラインで滞在に「写真を追加」すると、ここに並びます。
                </p>
                <button
                  type="button"
                  onClick={() => setView("day")}
                  className="mt-4 min-h-11 rounded-full border border-[var(--accent)] px-5 text-sm font-medium text-[var(--accent)]"
                >
                  日の表示に戻る
                </button>
              </div>
            )}
            {album.data && album.data.total > 0 && (
              <>
                {(() => {
                  const months = [
                    ...new Set(album.data.photos.map((p) => p.date.slice(0, 7))),
                  ].sort().reverse();
                  return (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-pressed={albumMonth === null}
                        onClick={() => setAlbumMonth(null)}
                        className={`min-h-9 rounded-full px-3 text-xs ${
                          albumMonth === null
                            ? "bg-[var(--accent)] text-white"
                            : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
                        }`}
                      >
                        すべて
                      </button>
                      {months.map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={albumMonth === m}
                          onClick={() => setAlbumMonth(m)}
                          className={`min-h-9 rounded-full px-3 text-xs ${
                            albumMonth === m
                              ? "bg-[var(--accent)] text-white"
                              : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
                          }`}
                        >
                          {monthLabel(m)}
                        </button>
                      ))}
                    </div>
                  );
                })()}
                {(() => {
                  const filtered = album.data.photos.filter(
                    (p) => !albumMonth || p.date.startsWith(albumMonth),
                  );
                  const byMonth = new Map<string, typeof filtered>();
                  for (const p of filtered) {
                    const key = p.date.slice(0, 7);
                    const arr = byMonth.get(key) ?? [];
                    arr.push(p);
                    byMonth.set(key, arr);
                  }
                  const sortedMonths = [...byMonth.keys()].sort().reverse();
                  if (filtered.length === 0) {
                    return (
                      <p className="py-10 text-center text-sm text-[var(--dim)]">
                        この月の写真はありません。
                      </p>
                    );
                  }
                  return sortedMonths.map((m) => (
                    <div key={m} className="mt-7">
                      <h3 className="font-serif text-lg">{monthLabel(m)}</h3>
                      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {(byMonth.get(m) ?? []).map((photo) => (
                          <figure key={photo.id} className="relative">
                            <a
                              href={photo.url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`${photo.date} ${photo.placeName ?? photo.address ?? "滞在場所"}の写真を大きく見る`}
                            >
                              <img
                                src={photo.url}
                                alt={photo.caption ?? photo.placeName ?? "滞在場所の写真"}
                                loading="lazy"
                                className="aspect-square w-full rounded-lg border border-[var(--border)] object-cover"
                              />
                            </a>
                            <button
                              type="button"
                              aria-label="この写真を削除"
                              disabled={deletePhoto.isPending}
                              onClick={() => deletePhoto.mutate(photo.id)}
                              className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-sm leading-none text-white disabled:opacity-50"
                            >
                              ×
                            </button>
                            <figcaption className="mt-1.5 px-0.5">
                              <p className="truncate text-[11px] leading-tight text-[var(--text)]">
                                {photo.placeName ?? photo.address ?? "場所の記録"}
                              </p>
                              <p className="text-[11px] leading-tight text-[var(--dim)]">
                                {photo.date.slice(5).replace("-", "/")}
                                {photo.caption ? ` ・ ${photo.caption}` : ""}
                              </p>
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </>
            )}
          </section>
        )}

        {view === "day" && (
          <>
        {/* Day notes (一言) */}
        <section aria-label="その日の一言" className="mt-5">
          {day.data && day.data.dayNotes.length > 0 && (
            <ul className="space-y-2">
              {day.data.dayNotes.map((note) => (
                <li
                  key={note.id}
                  className="flex items-start justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
                >
                  <p className="font-serif text-base leading-relaxed">
                    {note.text}
                  </p>
                  <button
                    type="button"
                    aria-label="この一言を削除"
                    disabled={deleteNote.isPending}
                    onClick={() => deleteNote.mutate(note.id)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm leading-none text-[var(--dim)] disabled:opacity-50"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (dayNoteText.trim()) addDayNote.mutate();
            }}
          >
            <label htmlFor="day-note" className="sr-only">
              その日の一言を追加
            </label>
            <input
              id="day-note"
              type="text"
              value={dayNoteText}
              onChange={(e) => setDayNoteText(e.target.value)}
              placeholder="この日の一言（例：市長選を見に行った）"
              maxLength={500}
              className="min-h-11 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm"
            />
            <button
              type="submit"
              disabled={!dayNoteText.trim() || addDayNote.isPending}
              className="min-h-11 shrink-0 rounded-full border border-[var(--accent)] px-4 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
            >
              一言を追加
            </button>
          </form>
        </section>

        {/* Map */}
        <div className="mt-5">
          <DayMap
            places={mapPlaces}
            mapKey={mapKey}
            getRows={() => rowRefs.current}
          />
        </div>

        {/* Timeline */}
        <section aria-label="その日のタイムライン" className="mt-6">
          {photoNote && (
            <p role="status" className="mb-3 text-sm text-[var(--dim)]">
              {photoNote}
            </p>
          )}
          {day.isPending && (
            <p className="py-8 text-center text-sm text-[var(--dim)]">
              読み込んでいます…
            </p>
          )}
          {day.error && (
            <p className="py-8 text-center text-sm text-[var(--dim)]">
              読み込みに失敗しました。
              <button
                type="button"
                onClick={() => void day.refetch()}
                className="ml-2 underline"
              >
                もう一度試す
              </button>
            </p>
          )}
          {day.data && segments.length === 0 && (
            <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] px-5 py-10 text-center">
              <p className="text-sm leading-relaxed text-[var(--dim)]">
                この日の記録はまだありません。
                {isToday
                  ? "「現在地を取り込む」を押すと、今日の分から貯まり始めます。"
                  : "過去分は、下の「過去の取り込み」からGoogleの書き出しファイルを取り込むと表示されます。"}
              </p>
            </div>
          )}
          {day.data && segments.length > 0 && (
            <ol className="relative ml-3 border-l-2 border-[var(--border)]">
              {segments.map((seg) => {
                const stayIndex =
                  seg.kind === "stay" ? stays.indexOf(seg) : -1;
                return (
                  <li
                    key={seg.id}
                    ref={
                      seg.kind === "stay"
                        ? (el) => {
                            rowRefs.current[stayIndex] = el;
                          }
                        : undefined
                    }
                    className="relative pb-6 pl-6 last:pb-0"
                  >
                    <span
                      aria-hidden
                      className={`absolute -left-[9px] top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-[var(--bg)] ${
                        seg.kind === "stay" && seg.source !== "provisional"
                          ? "bg-[var(--accent)]"
                          : "bg-[var(--dim)]"
                      }`}
                    />
                    {seg.kind === "stay" ? (
                      <div>
                        <div className="flex items-baseline gap-2">
                          {stayIndex >= 0 && (
                            <span className="flex h-5 w-5 shrink-0 translate-y-0.5 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-white">
                              {stayIndex + 1}
                            </span>
                          )}
                          <h3 className="font-serif text-xl leading-snug">
                            {seg.placeName ??
                              seg.address ??
                              (seg.source === "provisional"
                                ? "記録された場所"
                                : "滞在（場所の名前なし）")}
                          </h3>
                          {seg.source === "provisional" && (
                            <span className="shrink-0 translate-y-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--dim)]">
                              確定前
                            </span>
                          )}
                        </div>
                        {seg.source === "provisional" ? (
                          <p className="mt-1 text-sm text-[var(--dim)]">
                            {fmtTime(seg.startAt)}
                            {seg.startAt !== seg.endAt &&
                              ` 〜 ${fmtTime(seg.endAt)}`}{" "}
                            ・ 記録のみ（滞在確定前）
                          </p>
                        ) : (
                          <p className="mt-1 text-sm text-[var(--dim)]">
                            {fmtTime(seg.startAt)} 〜 {fmtTime(seg.endAt)} ・
                            滞在 {fmtDuration(seg.startAt, seg.endAt)}
                          </p>
                        )}
                        {seg.address && seg.placeName && (
                          <p className="mt-0.5 text-sm text-[var(--dim)]">
                            {seg.address}
                          </p>
                        )}
                        {!seg.placeName && (
                          <p className="mt-0.5 text-xs text-[var(--dim)]">
                            {seg.lat.toFixed(5)}, {seg.lng.toFixed(5)}
                          </p>
                        )}
                        {seg.source === "provisional" ? null : renaming?.id ===
                          seg.id ? (
                          <form
                            className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (renameText.trim()) rename.mutate();
                            }}
                          >
                            <label
                              htmlFor="stay-name"
                              className="text-sm font-medium"
                            >
                              この場所の名前
                            </label>
                            <input
                              id="stay-name"
                              type="text"
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              placeholder="例：自宅、実家、行きつけの店"
                              className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base"
                            />
                            <label className="mt-3 flex min-h-9 items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={registerPlace}
                                onChange={(e) =>
                                  setRegisterPlace(e.target.checked)
                                }
                                className="h-5 w-5"
                              />
                              この名前を場所として登録し、近くの滞在にも自動で付ける
                            </label>
                            <div className="mt-3 flex gap-2">
                              <button
                                type="submit"
                                disabled={!renameText.trim() || rename.isPending}
                                className="min-h-10 rounded-full bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
                              >
                                保存する
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenaming(null)}
                                className="min-h-10 rounded-full border border-[var(--border)] px-4 text-sm"
                              >
                                やめる
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setRenaming(seg);
                              setRenameText(seg.placeName ?? "");
                            }}
                            className="mt-2 min-h-9 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--dim)]"
                          >
                            {seg.placeName ? "名前を変える" : "名前をつける"}
                          </button>
                        )}
                        {seg.photos.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {seg.photos.map((photo) => (
                              <PhotoThumb
                                key={photo.id}
                                photo={photo}
                                alt={`${seg.placeName ?? seg.address ?? "滞在場所"}の写真`}
                                disabled={deletePhoto.isPending}
                                onDelete={() => deletePhoto.mutate(photo.id)}
                              />
                            ))}
                          </div>
                        )}
                        {seg.notes.length > 0 && (
                          <ul className="mt-3 space-y-1.5">
                            {seg.notes.map((note) => (
                              <li
                                key={note.id}
                                className="flex items-start justify-between gap-2 rounded-lg bg-[var(--surface)] px-3 py-2"
                              >
                                <p className="font-serif text-sm leading-relaxed">
                                  {note.text}
                                </p>
                                <button
                                  type="button"
                                  aria-label="この一言を削除"
                                  disabled={deleteNote.isPending}
                                  onClick={() => deleteNote.mutate(note.id)}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm leading-none text-[var(--dim)] disabled:opacity-50"
                                >
                                  ×
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={photoBusy}
                            onClick={() => {
                              setPhotoTarget(seg);
                              setPhotoNote(null);
                              photoInputRef.current?.click();
                            }}
                            className="min-h-9 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--dim)] disabled:opacity-50"
                          >
                            写真を追加
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setNoteTarget(
                                noteTarget?.id === seg.id ? null : seg,
                              );
                              setStayNoteText("");
                            }}
                            className="min-h-9 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--dim)]"
                          >
                            一言を追加
                          </button>
                        </div>
                        {noteTarget?.id === seg.id && (
                          <form
                            className="mt-2 flex gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (stayNoteText.trim()) addStayNote.mutate();
                            }}
                          >
                            <label
                              htmlFor={`stay-note-${seg.id}`}
                              className="sr-only"
                            >
                              この滞在への一言
                            </label>
                            <input
                              id={`stay-note-${seg.id}`}
                              type="text"
                              value={stayNoteText}
                              onChange={(e) => setStayNoteText(e.target.value)}
                              placeholder="この場所での一言"
                              maxLength={500}
                              autoFocus
                              className="min-h-10 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-sm"
                            />
                            <button
                              type="submit"
                              disabled={
                                !stayNoteText.trim() || addStayNote.isPending
                              }
                              className="min-h-10 shrink-0 rounded-full bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
                            >
                              保存
                            </button>
                          </form>
                        )}
                      </div>
                    ) : (
                      <div>
                        <p className="text-base">
                          <span className="font-medium">
                            {activityLabel(seg.activityType)}
                          </span>
                          <span className="text-[var(--dim)]">
                            {" "}
                            ・ {fmtTime(seg.startAt)} 〜 {fmtTime(seg.endAt)} ・{" "}
                            {seg.distanceM != null
                              ? fmtDistance(seg.distanceM)
                              : "距離不明"}
                          </span>
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Photos whose stay is no longer displayed on this date */}
        {day.data && day.data.loosePhotos.length > 0 && (
          <section aria-label="場所に紐づいていない写真" className="mt-6">
            <h2 className="font-serif text-lg">この日の写真</h2>
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              滞在の表示が変わったため、どの滞在にも紐づかなくなった写真です。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {day.data.loosePhotos.map((photo) => (
                <PhotoThumb
                  key={photo.id}
                  photo={photo}
                  alt="この日の写真"
                  disabled={deletePhoto.isPending}
                  onDelete={() => deletePhoto.mutate(photo.id)}
                />
              ))}
            </div>
          </section>
        )}

        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          multiple
          aria-label="滞在場所の写真を選ぶ"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void onPhotoFiles(files);
            e.target.value = "";
          }}
        />
          </>
        )}

        <ImportPanel />

        {/* Named places */}
        {namedPlaces.data && namedPlaces.data.places.length > 0 && (
          <section aria-label="名前つきの場所" className="mt-10">
            <h2 className="font-serif text-lg">名前つきの場所</h2>
            <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
              {namedPlaces.data.places.map((place) => (
                <li
                  key={place.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <p className="text-base font-medium">{place.name}</p>
                    <p className="text-xs text-[var(--dim)]">
                      {place.lat.toFixed(4)}, {place.lng.toFixed(4)} ・ 半径{" "}
                      {Math.round(place.radiusM)} m以内をこの名前で表示
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`${place.name}の登録を削除`}
                    onClick={() => deletePlace.mutate(place.id)}
                    className="min-h-9 shrink-0 rounded-full border border-[var(--border)] px-3 text-xs text-[var(--dim)]"
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Import history */}
        {imports.data && imports.data.imports.length > 0 && (
          <section aria-label="取り込み履歴" className="mt-10">
            <h2 className="font-serif text-lg">取り込み履歴</h2>
            <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
              {imports.data.imports.map((imp) => (
                <li
                  key={imp.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <p className="text-base font-medium">{imp.fileName}</p>
                    <p className="text-xs text-[var(--dim)]">
                      {imp.format}／滞在・移動 {imp.segmentCount} 件・ポイント{" "}
                      {imp.pointCount} 件
                      {imp.firstDate && imp.lastDate
                        ? `／${imp.firstDate} 〜 ${imp.lastDate}`
                        : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`${imp.fileName}の取り込みを取り消す`}
                    onClick={() => deleteImport.mutate(imp.id)}
                    className="min-h-9 shrink-0 rounded-full border border-[var(--border)] px-3 text-xs text-[var(--dim)]"
                  >
                    取り消す
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-[var(--dim)]">
              取り消すと、その期間の取り込み分（滞在・移動とポイント）が削除されます。複数のファイルを重ねて取り込んだ期間はまとめて消えることがあります。
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
