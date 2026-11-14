declare module "*.css";
declare module "*.jpg";
declare module "*.png";
declare module "*.webp";

// Bundled Meta map helpers (copied from the map runtime recipes). The
// HatchMaps global itself is provided by the classic script tag in
// index.html.
declare module "./map_helpers.mjs" {
  export interface MapPlace {
    label: string;
    venue?: string;
    address?: string;
    locality?: string;
    region?: string;
    country?: string;
    lat?: number;
    lng?: number;
    source?: string;
  }
  export type MapHandle = { selectPlace: (index: number) => void } | null;
  export function mountPlaceListMap(
    container: HTMLElement,
    options: {
      places: MapPlace[];
      rows: HTMLElement[];
      baseStyle?: string;
      selectedClass?: string;
    },
    onUnavailable: () => void,
  ): MapHandle;
  export function mountMap(
    container: HTMLElement,
    options: Record<string, unknown>,
    onUnavailable: () => void,
  ): MapHandle;
  export function mapsSearchUrl(place: MapPlace): string | null;
  export function mapsDirectionsUrl(
    place: MapPlace,
    options?: { origin?: { lat: number; lng: number }; travelmode?: string },
  ): string | null;
}
