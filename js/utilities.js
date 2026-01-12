import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
// utilities.js
// Shared data loading + preprocessing + derived metrics for all views.

const DATA_PATHS = {
  airlines: "./data/airlines.csv",
  airports: "./data/airports.csv",
  routes: "./data/routes.csv",
};

// -----------------------------
// Global singleton store (cached)
// -----------------------------
let _storePromise = null;

/**
 * Initialize and cache the global data store.
 * Safe to call multiple times — it will only load/process once.
 */
export async function initDataStore(options = {}) {
  if (_storePromise) return _storePromise;

  _storePromise = (async () => {
    const config = {
      // Distance bins (km) for Emma's Distance view:
      distanceBins: {
        shortMax: 1500,
        midMax: 4000,
      },
      // Default route filters
      defaults: {
        stopsOnly: true, // Stops === 0
        enabledDistanceClasses: new Set(["short", "mid", "long"]),
        // optional numeric range filter; null means no constraint
        minDistanceKm: null,
        maxDistanceKm: null,
      },
      // Limits to keep maps responsive (views can override)
      limits: {
        maxRoutesForMap: 2000,
      },
      ...options,
    };

    // Load raw CSVs
    const [airlinesRaw, airportsRaw, routesRaw] = await Promise.all([
      d3.csv(DATA_PATHS.airlines),
      d3.csv(DATA_PATHS.airports),
      d3.csv(DATA_PATHS.routes),
    ]);

    // Parse + index airports
    const airports = airportsRaw.map(parseAirportRow).filter(Boolean);
    const airportsByIATA = new Map();
    for (const a of airports) {
      if (a.iata) airportsByIATA.set(a.iata, a);
    }

    // Optional: if you later add Airport ID column back in airports.csv
    // this will start working automatically.
    const airportsById = new Map();
    for (const a of airports) {
      if (a.id != null) airportsById.set(a.id, a);
    }

    // Parse airlines (optional, but ready for later)
    const airlines = airlinesRaw.map(parseAirlineRow).filter(Boolean);
    const airlinesByIATA = new Map();
    for (const al of airlines) {
      if (al.iata) airlinesByIATA.set(al.iata, al);
    }

    // Parse routes + join airports + derive distance
    const routesParsed = routesRaw.map(parseRouteRow).filter(Boolean);

    const routesDerived = [];
    for (const r of routesParsed) {
      // join strategy: prefer ID if possible, fallback to IATA
      const src =
        (r.sourceAirportId != null ? airportsById.get(r.sourceAirportId) : null) ||
        (r.sourceIATA ? airportsByIATA.get(r.sourceIATA) : null);

      const dst =
        (r.destAirportId != null ? airportsById.get(r.destAirportId) : null) ||
        (r.destIATA ? airportsByIATA.get(r.destIATA) : null);

      if (!src || !dst) continue; // cannot draw or compute distance
      if (!isFiniteNumber(src.lat) || !isFiniteNumber(src.lon) || !isFiniteNumber(dst.lat) || !isFiniteNumber(dst.lon)) continue;

      const distance_km = haversineKm(src.lat, src.lon, dst.lat, dst.lon);
      if (!isFiniteNumber(distance_km) || distance_km <= 0) continue;

      const distance_class = classifyDistance(distance_km, config.distanceBins);

      routesDerived.push({
        ...r,
        src,
        dst,
        distance_km,
        distance_class,
        // optional helpers
        isStops0: r.stops === 0,
      });
    }

    // Precompute some light stats (useful across views)
    const stats = computeStats(routesDerived);

    // Global state (views can read & update)
    const state = {
      activeTab: "routing",
      filters: {
        stopsOnly: config.defaults.stopsOnly,
        enabledDistanceClasses: new Set(config.defaults.enabledDistanceClasses),
        minDistanceKm: config.defaults.minDistanceKm,
        maxDistanceKm: config.defaults.maxDistanceKm,
      },
      selection: {
        selectedRoute: null,
        selectedAirport: null,
      },
    };

    return {
      config,
      raw: { airlinesRaw, airportsRaw, routesRaw },
      airlines,
      airports,
      routesDerived,
      indexes: { airportsByIATA, airportsById, airlinesByIATA },
      stats,
      state,
    };
  })();

  return _storePromise;
}

// -----------------------------
// Parsing helpers
// -----------------------------
function parseAirportRow(d) {
  // Your airports.csv sample columns:
  // Name,City,Country,IATA,ICAO,Latitude,Longitude,Altitude,Timezone,DST,Timezone
  // Note: "Airport ID" is not present in your sample, so id will be null.
  const name = (d.Name ?? "").trim();
  const city = (d.City ?? "").trim();
  const country = (d.Country ?? "").trim();
  const iata = normalizeCode(d.IATA);
  const icao = normalizeCode(d.ICAO);

  const lat = toNumber(d.Latitude);
  const lon = toNumber(d.Longitude);

  // Altitude appears to be in feet in many OpenFlights-like datasets; keep as numeric as-is
  const altitude = toNumber(d.Altitude);

  // If you later add an "Airport ID" column, we’ll capture it:
  const id = d["Airport ID"] != null ? toInt(d["Airport ID"]) : null;

  // Filter out unusable rows
  if (!name && !iata) return null;

  return {
    id, // may be null
    name,
    city,
    country,
    iata, // may be null
    icao, // may be null
    lat,
    lon,
    altitude,
  };
}

function parseAirlineRow(d) {
  // airlines.csv sample:
  // Name,IATA,ICAO,Callsign,Country,Active
  const name = (d.Name ?? "").trim();
  const iata = normalizeCode(d.IATA);
  const icao = normalizeCode(d.ICAO);
  const callsign = (d.Callsign ?? "").trim();
  const country = (d.Country ?? "").trim();
  const active = (d.Active ?? "").trim(); // "Y" / "N"

  if (!name && !iata && !icao) return null;

  return { name, iata, icao, callsign, country, active };
}

function parseRouteRow(d) {
  // routes.csv sample:
  // Airline,Airline ID,Source Airport,Source Airport ID,Destination Airport,Destination Airport ID,Codeshare,Stops,Equipment
  const airline = normalizeCode(d.Airline);
  const airlineId = toInt(d["Airline ID"]);
  const sourceIATA = normalizeCode(d["Source Airport"]);
  const destIATA = normalizeCode(d["Destination Airport"]);

  const sourceAirportId = toInt(d["Source Airport ID"]);
  const destAirportId = toInt(d["Destination Airport ID"]);

  const codeshare = (d.Codeshare ?? "").trim();
  const stops = toInt(d.Stops);
  const equipment = (d.Equipment ?? "").trim();

  // basic validity: must have some form of source/dest identifiers
  if (!sourceIATA && sourceAirportId == null) return null;
  if (!destIATA && destAirportId == null) return null;

  return {
    airline,
    airlineId,
    sourceIATA,
    destIATA,
    sourceAirportId,
    destAirportId,
    codeshare,
    stops: stops ?? 0,
    equipment,
  };
}

// -----------------------------
// Distance math + classification
// -----------------------------
export function haversineKm(lat1, lon1, lat2, lon2) {
  // Great-circle distance in kilometers
  const R = 6371; // Earth radius (km)
  const toRad = (deg) => (deg * Math.PI) / 180;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function classifyDistance(distanceKm, bins = { shortMax: 1500, midMax: 4000 }) {
  if (distanceKm < bins.shortMax) return "short";
  if (distanceKm < bins.midMax) return "mid";
  return "long";
}

// -----------------------------
// Shared filtering / querying
// -----------------------------
/**
 * Get routes after applying filters.
 * filters:
 *  - stopsOnly (boolean)
 *  - enabledDistanceClasses (Set of "short"|"mid"|"long")
 *  - minDistanceKm / maxDistanceKm (number|null)
 */
export function getFilteredRoutes(store, filters) {
  const f = filters ?? store.state.filters;

  const enabled = f.enabledDistanceClasses ?? new Set(["short", "mid", "long"]);
  const stopsOnly = !!f.stopsOnly;
  const minKm = f.minDistanceKm;
  const maxKm = f.maxDistanceKm;

  return store.routesDerived.filter((r) => {
    if (stopsOnly && r.stops !== 0) return false;
    if (!enabled.has(r.distance_class)) return false;
    if (minKm != null && r.distance_km < minKm) return false;
    if (maxKm != null && r.distance_km > maxKm) return false;
    return true;
  });
}

/**
 * Useful for maps: sample or cap route count to avoid overplotting.
 */
export function capRoutes(routes, maxCount = 2000, strategy = "longFirst") {
  if (routes.length <= maxCount) return routes;

  if (strategy === "random") {
    // Fisher–Yates partial shuffle
    const arr = routes.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, maxCount);
  }

  // default: longFirst — keep longest routes (best for Distance/Curvature teaching)
  return routes
    .slice()
    .sort((a, b) => b.distance_km - a.distance_km)
    .slice(0, maxCount);
}

/**
 * Build histogram bins for distance distribution chart.
 * Returns { bins: [{x0,x1,count}], maxCount }
 */
export function makeDistanceHistogram(routes, binCount = 30) {
  const values = routes.map((r) => r.distance_km).filter(isFiniteNumber);
  if (values.length === 0) return { bins: [], maxCount: 0 };

  const min = Math.min(...values);
  const max = Math.max(...values);

  const step = (max - min) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    x0: min + i * step,
    x1: min + (i + 1) * step,
    count: 0,
  }));

  for (const v of values) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - min) / step)));
    bins[idx].count += 1;
  }

  const maxCount = Math.max(...bins.map((b) => b.count), 0);
  return { bins, maxCount, min, max };
}

/**
 * Count routes by distance_class (short/mid/long).
 */
export function countByDistanceClass(routes) {
  const out = { short: 0, mid: 0, long: 0 };
  for (const r of routes) out[r.distance_class] = (out[r.distance_class] ?? 0) + 1;
  return out;
}

/**
 * Simple hub metric: departing route counts per source airport (IATA).
 * Returns array sorted desc: [{iata, airport, count}]
 */
export function computeOutDegree(store, routes = store.routesDerived) {
  const m = new Map();
  for (const r of routes) {
    const key = r.src?.iata ?? null;
    if (!key) continue;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const [iata, count] of m.entries()) {
    out.push({ iata, airport: store.indexes.airportsByIATA.get(iata) ?? null, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// -----------------------------
// Stats (optional but useful)
// -----------------------------
function computeStats(routesDerived) {
  const total = routesDerived.length;
  const byClass = countByDistanceClass(routesDerived);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (const r of routesDerived) {
    const d = r.distance_km;
    if (!isFiniteNumber(d)) continue;
    min = Math.min(min, d);
    max = Math.max(max, d);
    sum += d;
  }

  return {
    totalRoutes: total,
    byDistanceClass: byClass,
    minDistanceKm: isFinite(min) ? min : null,
    maxDistanceKm: isFinite(max) ? max : null,
    meanDistanceKm: total ? sum / total : null,
  };
}

// -----------------------------
// Small utilities
// -----------------------------
function normalizeCode(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "" || s === "\\N" || s === "N/A" || s === "-") return null;
  return s;
}

function toNumber(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "" || s === "\\N") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNumber(v);
  if (n == null) return null;
  const i = Math.trunc(n);
  return Number.isFinite(i) ? i : null;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
