import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

import { initDataStore, computeOutDegree } from "./utilities.js";

const WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
let _worldTopo = null;
let _land = null;
let _borders = null;

const LAND_FILL = "#dde5ee";
const BORDER_STROKE = "#c7d0dc";
const SPHERE_FILL = "#f7fbff";
const GRID_STROKE = "#e5e7eb";

// Elevation colors
const LOW_COLOR = "green";
const MID_COLOR = "blue";
const HIGH_COLOR = "red";

// Dots styling
const DOT_R = 2.4;
const DOT_STROKE = "white";
const DOT_STROKE_W = 0.7;
const DOT_OPACITY = 0.75;

const viewState = {
  thresholds: null, // { q1, q2 } in feet
  pointsSel: null,
  scatterPointsSel: null,
  scatterBrushPx: null,     // [[x0,y0],[x1,y1]] in pixel space, or null
  brushedIatas: null,       // Set(iata) or null
};

// -------------------------
// shared world layers loader
// -------------------------
async function loadWorldLayers() {
  if (_land && _borders) return { land: _land, borders: _borders };
  if (!_worldTopo) _worldTopo = await d3.json(WORLD_ATLAS_URL);

  const countries = _worldTopo.objects.countries;
  _land = topojson.feature(_worldTopo, countries);
  _borders = topojson.mesh(_worldTopo, countries, (a, b) => a !== b);

  return { land: _land, borders: _borders };
}

// -------------------------
// elevation helpers
// -------------------------
function computeElevationThresholds() {
  // q1: < 5000
  // q2: 5000 - 8000
  // q3: > 8000
  return { q1: 5000, q2: 8000 };
}

function elevationGroup(altFt, thresholds) {
  if (altFt == null || !Number.isFinite(altFt)) return null;
  if (altFt < thresholds.q1) return "low";      // < 5000
  if (altFt <= thresholds.q2) return "mid";     // 5000–8000
  return "high";                                // > 8000
}

function elevationColor(group) {
  if (group === "low") return LOW_COLOR;
  if (group === "mid") return MID_COLOR;
  if (group === "high") return HIGH_COLOR;
  return "#9ca3af";
}

function fmtFeet(v) {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${Math.round(v).toLocaleString()} ft`;
}

function fmtMetersFromFeet(v) {
  if (v == null || !Number.isFinite(v)) return "";
  const m = v * 0.3048;
  return ` (${Math.round(m).toLocaleString()} m)`;
}

function highlightScatterPoint(iata) {
  const sel = viewState.scatterPointsSel;
  if (!sel) return;

  // dim all
  sel.attr("opacity", 0.18)
    .attr("r", 2.5)
    .attr("stroke", "white")
    .attr("stroke-width", 0.6);

  // highlight matched
  sel.filter((d) => d.iata === iata)
    .attr("opacity", 1)
    .attr("r", 6)
    .attr("stroke", "#111827")
    .attr("stroke-width", 1.4)
    .raise();
}

function clearScatterHighlight() {
  updateScatterBrushStyle();
}

function updateScatterBrushStyle() {
  const sel = viewState.scatterPointsSel;
  const brushed = viewState.brushedIatas;
  if (!sel) return;

  // no brush -> default
  if (!brushed) {
    sel.attr("opacity", 0.8)
      .attr("r", 2.5)
      .attr("stroke", "white")
      .attr("stroke-width", 0.6);
    return;
  }

  // brush active -> fade others, emphasize selected
  sel
    .attr("opacity", (d) => (brushed.has(d.iata) ? 1 : 0.12))
    .attr("r", (d) => (brushed.has(d.iata) ? 3.4 : 2.3))
    .attr("stroke", (d) => (brushed.has(d.iata) ? "#111827" : "white"))
    .attr("stroke-width", (d) => (brushed.has(d.iata) ? 1.1 : 0.6));
}

function applyScatterBrushToMap() {
  const pts = viewState.pointsSel;
  const brushed = viewState.brushedIatas;
  if (!pts) return;

  if (!brushed) {
    pts.style("display", null);
    return;
  }

  pts.style("display", (d) => (brushed.has(d.iata) ? null : "none"));
}

// -------------------------
// tooltip
// -------------------------
function ensureMapTooltip(svg) {
  let tip = svg.select("g._elevTooltip");
  if (!tip.empty()) return tip;

  tip = svg
    .append("g")
    .attr("class", "_elevTooltip")
    .style("display", "none")
    .style("pointer-events", "none");

  tip.append("rect").attr("rx", 8).attr("fill", "#111827").attr("opacity", 0.92);

  tip.append("text").attr("x", 10).attr("y", 18).attr("font-size", 12).attr("fill", "white");

  return tip;
}

function showMapTooltip(svg, event, text) {
  const tip = ensureMapTooltip(svg);
  tip.raise();

  const t = tip.select("text");
  t.selectAll("tspan").remove();

  const lines = String(text).split("\n");
  lines.forEach((line, i) => {
    t.append("tspan").attr("x", 10).attr("dy", i === 0 ? 0 : 16).text(line);
  });

  const bb = t.node().getBBox();
  tip.select("rect").attr("width", bb.width + 20).attr("height", bb.height + 14);

  tip.style("display", null);
  moveMapTooltip(svg, event);
}

function moveMapTooltip(svg, event) {
  const tip = svg.select("g._elevTooltip");
  if (tip.empty()) return;

  tip.raise();

  const bounds = svg.property("__sphereBounds__"); // [[x0,y0],[x1,y1]]
  const legendBBox = svg.property("__legendBBox__"); // {x,y,w,h}
  const pad = 12;

  const [mx, my] = d3.pointer(event, svg.node());

  const rect = tip.select("rect").node().getBBox();
  const tw = rect.width;
  const th = rect.height;

  let x = mx + 12;
  let y = my + 12;

  if (bounds) {
    const [[x0, y0], [x1, y1]] = bounds;

    if (x + tw + pad > x1) x = mx - tw - 12;
    if (y + th + pad > y1) y = my - th - 12;

    x = Math.max(x0 + pad, Math.min(x, x1 - tw - pad));
    y = Math.max(y0 + pad, Math.min(y, y1 - th - pad));
  }

  if (legendBBox) {
    const overlap =
      x < legendBBox.x + legendBBox.w &&
      x + tw > legendBBox.x &&
      y < legendBBox.y + legendBBox.h &&
      y + th > legendBBox.y;

    if (overlap) {
      x = legendBBox.x - tw - 10;
      if (bounds) {
        const [[x0, y0]] = bounds;
        if (x < x0 + pad) {
          x = mx + 12;
          y = legendBBox.y - th - 10;
        }
      }
    }
  }

  tip.attr("transform", `translate(${x},${y})`);
}

function hideMapTooltip(svg) {
  svg.select("g._elevTooltip").style("display", "none");
}

function formatAirportTooltip(a, group, thresholds) {
  const name = a.name || a.iata || "Airport";
  const iata = a.iata ? ` (${a.iata})` : "";
  const city = a.city ? `, ${a.city}` : "";
  const country = a.country ? `, ${a.country}` : "";

  let groupLabel = "Unknown elevation";
  if (group === "low") groupLabel = `Low (< ${fmtFeet(thresholds.q1)})`;
  if (group === "mid") groupLabel = `Mid (${fmtFeet(thresholds.q1)} – ${fmtFeet(thresholds.q2)})`;
  if (group === "high") groupLabel = `High (> ${fmtFeet(thresholds.q2)})`;

  const alt = fmtFeet(a.altitude) + fmtMetersFromFeet(a.altitude);

  // departing routes (same as scatter chart)
  const dep = a.routesDeparting ?? 0;

  return `${name}${iata}${city}${country}
Altitude: ${alt}
Departing routes: ${dep.toLocaleString()}
Group: ${groupLabel}`;
}


// -------------------------
// legend
// -------------------------
function drawElevationLegend(svg, geoPath, thresholds) {
  const boxW = 300;
  const boxH = 113;

  const topPad = 0;
  const rightPad = 25;

  const width = +svg.attr("width");
  const x = Math.max(0, width - boxW - rightPad);
  const y = Math.max(0, topPad);

  const g = svg.append("g")
    .attr("class", "elev-legend")
    .attr("transform", `translate(${x},${y})`);

  g.append("rect")
    .attr("width", boxW)
    .attr("height", boxH)
    .attr("rx", 10)
    .attr("fill", "white")
    .attr("opacity", 0.92)
    .attr("stroke", "#e5e7eb");

  g.append("text")
    .attr("x", 12)
    .attr("y", 20)
    .attr("font-size", 12)
    .attr("fill", "#111827")
    .attr("font-weight", 600)
    .text("Airport elevation groups");

  g.append("text")
    .attr("x", 12)
    .attr("y", 38)
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("5k/8k ft cutoffs aligned with FAA high-elevation guidance");

  const rows = [
    { label: `High (> ${fmtFeet(thresholds.q2)})`, color: HIGH_COLOR },
    { label: `Mid (${fmtFeet(thresholds.q1)} – ${fmtFeet(thresholds.q2)})`, color: MID_COLOR },
    { label: `Low (< ${fmtFeet(thresholds.q1)})`, color: LOW_COLOR },
  ];

  const x0Row = 16;
  let yRow = 60;

  rows.forEach((r) => {
    g.append("circle").attr("cx", x0Row + 10).attr("cy", yRow - 4).attr("r", 6).attr("fill", r.color).attr("opacity", 0.85).attr("stroke", "white").attr("stroke-width", 0.8);
    g.append("text").attr("x", x0Row + 26).attr("y", yRow).attr("font-size", 11).attr("fill", "#374151").text(r.label);
    yRow += 22;
  });

  // store legend bbox for tooltip avoidance
  const lb = g.node().getBBox();
  const t = g.attr("transform");
  const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(t);
  const tx = m ? +m[1] : 0;
  const ty = m ? +m[2] : 0;

  svg.property("__legendBBox__", {
    x: tx + lb.x,
    y: ty + lb.y,
    w: lb.width,
    h: lb.height,
  });
}

function parseEquipmentList(eqStr) {
  if (!eqStr) return [];
  const s = String(eqStr).trim();
  if (!s || s === "\\N") return [];

  // Split on common separators: space, comma, slash, semicolon
  return s
    .split(/[\s,\/;|]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildEquipmentStackData(store, thresholds, topK = 7) {
  const routes = store.routesDerived || [];

  // counts[group][equipment] = raw count
  const counts = {
    low: new Map(),
    mid: new Map(),
    high: new Map(),
  };

  // global equipment counts (for topK selection)
  const global = new Map();

  for (const r of routes) {
    const alt = r?.src?.altitude;
    if (!Number.isFinite(alt)) continue;

    const group = elevationGroup(alt, thresholds);
    if (!group) continue;

    const eqList = parseEquipmentList(r.equipment);
    const finalList = eqList.length ? eqList : ["Unknown"];

    for (const eq of finalList) {
      counts[group].set(eq, (counts[group].get(eq) ?? 0) + 1);
      global.set(eq, (global.get(eq) ?? 0) + 1);
    }
  }

  // pick topK equipment types globally
  const top = Array.from(global.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([k]) => k);

  const KEYS = [...top, "Other"];

  const groups = ["low", "mid", "high"];

  // Raw count rows
  const rowsCount = groups.map((g) => {
    const row = { group: g };
    for (const k of KEYS) row[k] = 0;

    for (const [eq, c] of counts[g].entries()) {
      if (top.includes(eq)) row[eq] += c;
      else row["Other"] += c;
    }
    return row;
  });

  // Convert counts -> shares (each group sums to 1)
  const rowsShare = rowsCount.map((row) => {
    const total = KEYS.reduce((s, k) => s + (row[k] ?? 0), 0) || 1;
    const out = { group: row.group };
    for (const k of KEYS) out[k] = (row[k] ?? 0) / total;
    return out;
  });

  return { rowsShare, rowsCount, keys: KEYS };
}

function groupLabel(g) {
  if (g === "low") return "Low";
  if (g === "mid") return "Mid";
  if (g === "high") return "High";
  return g;
}

// -------------------------
// render map
// -------------------------
async function renderMap(ctx) {
  const { mapSvg: svg, width, height } = ctx;
  const store = await initDataStore();

  const depCount = computeDeparturesByAirport(store.routesDerived || []);

  svg.selectAll("*").remove();

  const projection = d3.geoNaturalEarth1()
    .scale(125)
    .translate([width / 2 - 14, height / 2 + 45]);

  const geoPath = d3.geoPath(projection);

  // Sphere
  svg.append("path")
    .datum({ type: "Sphere" })
    .attr("d", geoPath)
    .attr("fill", SPHERE_FILL)
    .attr("stroke", "#d1d5db")
    .attr("stroke-width", 1);

  // Land + borders
  const { land, borders } = await loadWorldLayers();

  svg.append("path")
    .datum(land)
    .attr("d", geoPath)
    .attr("fill", LAND_FILL)
    .attr("stroke", "none")
    .attr("opacity", 1);

  svg.append("path")
    .datum(borders)
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", BORDER_STROKE)
    .attr("stroke-width", 0.7)
    .attr("opacity", 0.95);

  // Graticule
  const graticule = d3.geoGraticule().step([30, 30]);
  svg.append("path")
    .datum(graticule())
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", GRID_STROKE)
    .attr("stroke-width", 0.8)
    .attr("opacity", 0.55);

  // For tooltip clamp region
  svg.property("__sphereBounds__", geoPath.bounds({ type: "Sphere" }));

  // Recompute thresholds every render
  const thresholds = computeElevationThresholds();
  viewState.thresholds = thresholds;

  ensureMapTooltip(svg);

  //  Deduplicate airports by IATA and pick the "best" record
  const bestByIATA = new Map();

  for (const a of store.airports || []) {
    if (!a.iata) continue;
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;

    const prev = bestByIATA.get(a.iata);

    // scoring: prefer rows with valid altitude
    const score = (x) => {
      let s = 0;
      if (Number.isFinite(x.lat) && Number.isFinite(x.lon)) s += 10;
      if (Number.isFinite(x.altitude)) s += 5;
      if (x.name) s += 1;
      return s;
    };

    if (!prev || score(a) > score(prev)) {
      bestByIATA.set(a.iata, a);
    }
  }

  const airportsUnique = Array.from(bestByIATA.values());

  // Precompute group
  const airportData = airportsUnique.map((a) => ({
    ...a,
    group: elevationGroup(a.altitude, thresholds),
    routesDeparting: depCount.get(a.iata) ?? 0,    
  }));

  const dotsG = svg.append("g").attr("class", "elev-airports");

  const points = dotsG
    .selectAll("circle.airport")
    .data(airportData, (d) => d.iata)
    .join("circle")
    .attr("class", "airport")
    .attr("r", DOT_R)
    .attr("fill", (d) => elevationColor(d.group))
    .attr("opacity", DOT_OPACITY)
    .attr("stroke", DOT_STROKE)
    .attr("stroke-width", DOT_STROKE_W)
    .attr("transform", (d) => {
      const p = projection([d.lon, d.lat]);
      return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
    })
    .on("mouseenter", function (event, d) {
      d3.select(this).attr("opacity", 1).raise();
      showMapTooltip(svg, event, formatAirportTooltip(d, d.group, thresholds));

      // LINK: highlight scatter dot
      highlightScatterPoint(d.iata);
    })
    .on("mousemove", function (event) {
      moveMapTooltip(svg, event);
    })
    .on("mouseleave", function () {
      d3.select(this).attr("opacity", DOT_OPACITY);
      hideMapTooltip(svg);

      // LINK: reset scatter
      clearScatterHighlight();
    });

  viewState.pointsSel = points;

  drawElevationLegend(svg, geoPath, thresholds);
}


function getChartSize(svgEl, fallbackW = 420, fallbackH = 260) {
  const parent = svgEl.parentElement;
  const rect = parent ? parent.getBoundingClientRect() : null;
  const w = rect?.width ? Math.floor(rect.width) : fallbackW;
  const h = rect?.height ? Math.floor(rect.height) : fallbackH;
  return { w, h };
}

function computeDeparturesByAirport(routesDerived) {
  const m = new Map();

  for (const r of routesDerived || []) {
    const s = r?.src?.iata;
    if (s) m.set(s, (m.get(s) ?? 0) + 1);
  }

  return m;
}

// -------------------------
// unique aircraft types per elevation group
// -------------------------
function buildUniqueEquipmentByGroup(store, thresholds) {
  const routes = store.routesDerived || [];

  const groups = ["low", "mid", "high"];
  const sets = {
    low: new Set(),
    mid: new Set(),
    high: new Set(),
  };

  // Also keep route counts per group (useful for tooltip)
  const routeCounts = { low: 0, mid: 0, high: 0 };

  for (const r of routes) {
    const alt = r?.src?.altitude;
    if (!Number.isFinite(alt)) continue;

    const g = elevationGroup(alt, thresholds);
    if (!g) continue;

    routeCounts[g]++;

    const eqList = parseEquipmentList(r.equipment);
    const finalList = eqList.length ? eqList : ["Unknown"];

    for (const eq of finalList) {
      sets[g].add(eq);
    }
  }

  return groups.map((g) => ({
    group: g,
    unique: sets[g].size,
    routes: routeCounts[g],
  }));
}

function renderElevationScatter(svgEl, store, thresholds) {
  const { w, h } = getChartSize(svgEl, 460, 320);

  const margin = {
    top: 30,
    right: 10,
    bottom: Math.max(30, Math.round(h * 0.15)), // scale with height
    left: Math.max(46, Math.round(w * 0.13)),   // scale with width
  };
  const innerW = w - margin.left - margin.right;
  const innerH = h - margin.top - margin.bottom;

  const svg = d3.select(svgEl)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`);

  svg.selectAll("*").remove();

  // Title
  svg.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Flight Routes vs. Airport Altitude");

  const rangeText = svg.append("text")
    .attr("class", "brush-range-text")
    .attr("x", w - 10)
    .attr("y", 18)
    .attr("text-anchor", "end")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text(viewState.scatterBrushPx ? "Brushed selection" : "Drag to filter");

  // Build data: join airport altitude + route count
  const routeCount = computeDeparturesByAirport(store.routesDerived || []);

  const data = (store.airports || [])
    .map((a) => {
      const iata = a.iata;
      if (!iata) return null;
      const alt = a.altitude;
      const cnt = routeCount.get(iata) ?? 0;
      if (!Number.isFinite(alt)) return null;          // require altitude
      return {
        iata,
        name: a.name,
        city: a.city,
        country: a.country,
        altitude: alt,
        routes: cnt,
        group: elevationGroup(alt, thresholds),
      };
    })
    .filter(Boolean);

  if (data.length === 0) {
    svg.append("text")
      .attr("x", 14)
      .attr("y", 48)
      .attr("font-size", 12)
      .attr("fill", "#6b7280")
      .text("No valid airport altitude data available.");
    return;
  }

  // Scales
  const x = d3.scaleLinear()
    .domain(d3.extent(data, (d) => d.altitude))
    .nice()
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, (d) => d.routes) || 1])
    .nice()
    .range([innerH, 0]);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  // Axes
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(4))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  g.append("g")
    .call(d3.axisLeft(y).ticks(4))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  // Axis labels
  svg.append("text")
    .attr("x", margin.left + innerW / 2)
    .attr("y", h - 3)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("Airport altitude (ft)");

  svg.append("text")
    .attr("transform", `translate(14, ${margin.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("Number of flights");

  // Tooltip (HTML div inside side panel for simplicity)
  const tip = d3.select(svgEl.parentElement)
    .selectAll("div._elevScatterTip")
    .data([null])
    .join("div")
    .attr("class", "_elevScatterTip")
    .style("position", "absolute")
    .style("pointer-events", "none")
    .style("display", "none")
    .style("background", "#111827")
    .style("color", "white")
    .style("padding", "8px 10px")
    .style("border-radius", "10px")
    .style("font-size", "10px")
    .style("opacity", "0.92");

  // Ensure the parent is positioned (so absolute tooltip works)
  d3.select(svgEl.parentElement).style("position", "relative");

  function showTip(event, d) {
    const lines = [
      `${d.name || d.iata} (${d.iata})`,
      `${d.city ? d.city + ", " : ""}${d.country || ""}`.trim(),
      `Altitude: ${fmtFeet(d.altitude)}`,
      `Routes: ${d.routes.toLocaleString()}`,
    ].filter(Boolean);

    tip.style("display", "block").html(lines.join("<br/>"));
    moveTip(event);
  }

  function moveTip(event) {
    const [mx, my] = d3.pointer(event, svgEl.parentElement);
    tip.style("left", `${mx + 10}px`).style("top", `${my + 10}px`);
  }

  function hideTip() {
    tip.style("display", "none");
  }

  // Points
  const scatterPoints = g.append("g")
    .selectAll("circle.scatter-point")
    .data(data, (d) => d.iata)
    .join("circle")
    .attr("class", "scatter-point")
    .attr("cx", (d) => x(d.altitude))
    .attr("cy", (d) => y(d.routes))
    .attr("r", 2.5)
    .attr("fill", (d) => elevationColor(d.group))
    .attr("opacity", 0.8)
    .attr("stroke", "white")
    .attr("stroke-width", 0.6)
    .on("mouseenter", function (event, d) {
      d3.select(this).attr("opacity", 1).attr("r", 4).raise();
      showTip(event, d);
    })
    .on("mousemove", function (event) {
      moveTip(event);
    })
    .on("mouseleave", function () {
      // d3.select(this).attr("opacity", 0.8).attr("r", 2.5);
      hideTip();
      // restore brush style (or default if no brush)
      updateScatterBrushStyle();

    });

    // ----------------------------
// Brush (2D) like distance.js
// ----------------------------
const brush = d3.brush()
  .extent([[0, 0], [innerW, innerH]])
  .on("brush end", (event) => {
    if (!event.selection) {
      // cleared
      viewState.scatterBrushPx = null;
      viewState.brushedIatas = null;
      rangeText.text("Drag to filter");

      updateScatterBrushStyle();
      applyScatterBrushToMap();
      return;
    }

    const [[x0, y0], [x1, y1]] = event.selection;
    viewState.scatterBrushPx = [[x0, y0], [x1, y1]];

    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);

    // compute brushed airport set
    const brushed = new Set();
    for (const d of data) {
      const px = x(d.altitude);
      const py = y(d.routes);
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        brushed.add(d.iata);
      }
    }

    viewState.brushedIatas = brushed;
    rangeText.text(`Selected: ${brushed.size.toLocaleString()}`);

    updateScatterBrushStyle();
    applyScatterBrushToMap();
  });

g.append("g")
  .attr("class", "brush")
  .call(brush);

// restore previous brush position on rerender
if (viewState.scatterBrushPx) {
  g.select("g.brush").call(brush.move, viewState.scatterBrushPx);
}

  // store selection for linking + brushing
  viewState.scatterPointsSel = scatterPoints;

  // if a brush is already active, apply its style immediately
  updateScatterBrushStyle();
}

function renderEquipmentStackedBar(svgEl, store, thresholds) {
  const { w, h } = getChartSize(svgEl, 460, 180);

  //  more top margin so bars start lower (avoid title overlap)
  const margin = {
    top: 28,
    right: 120,
    bottom: 18,
    left: 60,
  };

  const innerW = Math.max(10, w - margin.left - margin.right);
  const innerH = Math.max(10, h - margin.top - margin.bottom);

  const svg = d3.select(svgEl)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`);

  svg.selectAll("*").remove();

  //  Title stays at top
  svg.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Aircraft share by altitude group (100%)");

  const { rowsShare, rowsCount, keys } = buildEquipmentStackData(store, thresholds, 7);
  if (!rowsShare.length) return;

  const groups = rowsShare.map((d) => d.group);

  // Stack SHARE rows
  const stack = d3.stack().keys(keys);
  const series = stack(rowsShare);

  const x = d3.scaleBand()
    .domain(groups)
    .range([0, innerW])
    .padding(0.35);

  const y = d3.scaleLinear()
    .domain([0, 1])
    .range([innerH, 0]);

  // plotting group starts lower due to margin.top
  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // Axes
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickFormat(groupLabel))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 11))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  g.append("g")
    .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%")))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 11))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  // Y label
  svg.append("text")
    .attr("transform", `translate(16, ${margin.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("Share of routes");

  // Tooltip (HTML)
  const tip = d3.select(svgEl.parentElement)
    .selectAll("div._equipTip")
    .data([null])
    .join("div")
    .attr("class", "_equipTip")
    .style("position", "absolute")
    .style("pointer-events", "none")
    .style("display", "none")
    .style("background", "#111827")
    .style("color", "white")
    .style("padding", "8px 10px")
    .style("border-radius", "10px")
    .style("font-size", "12px")
    .style("opacity", "0.92");

  d3.select(svgEl.parentElement).style("position", "relative");

  function showTip(event, html) {
    tip.style("display", "block").html(html);
    moveTip(event);
  }
  function moveTip(event) {
    const [mx, my] = d3.pointer(event, svgEl.parentElement);
    tip.style("left", `${mx + 10}px`).style("top", `${my + 10}px`);
  }
  function hideTip() {
    tip.style("display", "none");
  }

  // Helper for raw counts lookup
  const countByGroup = new Map(rowsCount.map((r) => [r.group, r]));

  // Draw stacks
  const layers = g.append("g")
    .selectAll("g.layer")
    .data(series)
    .join("g")
    .attr("class", "layer")
    .attr("fill", (d) => d3.schemeTableau10[keys.indexOf(d.key) % 10]);

  layers.selectAll("rect")
    .data((s) =>
      s.map((v) => ({
        key: s.key,
        v,
        group: v.data.group,
      }))
    )
    .join("rect")
    .attr("x", (d) => x(d.group))
    .attr("y", (d) => y(d.v[1]))
    .attr("height", (d) => Math.max(0, y(d.v[0]) - y(d.v[1])))
    .attr("width", x.bandwidth())
    .attr("opacity", 0.88)
    .on("mouseenter", function (event, d) {
      const share = (d.v[1] - d.v[0]) || 0;
      const rawRow = countByGroup.get(d.group);
      const rawCount = rawRow ? (rawRow[d.key] ?? 0) : 0;

      showTip(
        event,
        `${d.key}<br/>
         Share: <b>${(share * 100).toFixed(1)}%</b><br/>
         Routes: ${rawCount.toLocaleString()}`
      );

      d3.select(this).attr("opacity", 1);
    })
    .on("mousemove", function (event) {
      moveTip(event);
    })
    .on("mouseleave", function () {
      hideTip();
      d3.select(this).attr("opacity", 0.88);
    });

  // Vertical legend on the RIGHT
  const legendX = margin.left + innerW + 12;
  const legendY = margin.top;

  const leg = svg.append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  const rowH = 16;
  const legendKeys = keys;

  leg.append("text")
    .attr("x", 8)
    .attr("y", -16)
    .attr("font-size", 10.5)
    .attr("fill", "#6b7280")
    .attr("font-weight", 600)
    .text("Aircraft");

  const item = leg.selectAll("g.item")
    .data(legendKeys)
    .join("g")
    .attr("class", "item")
    .attr("transform", (d, i) => `translate(10, ${i * rowH})`);

  item.append("rect")
    .attr("x", 0)
    .attr("y", -10)
    .attr("width", 10)
    .attr("height", 10)
    .attr("fill", (k) => d3.schemeTableau10[keys.indexOf(k) % 10])
    .attr("opacity", 0.85);

  item.append("text")
    .attr("x", 14)
    .attr("y", -1)
    .attr("font-size", 10.5)
    .attr("fill", "#6b7280")
    .text((k) => (k.length > 12 ? k.slice(0, 11) + "…" : k));
}

function renderEquipmentDiversityBar(svgEl, store, thresholds) {
  const { w, h } = getChartSize(svgEl, 460, 170);

  const margin = {
    top: 30,
    right: 18,
    bottom: 30,
    left: 70,   //  more space for y labels
  };

  const innerW = Math.max(10, w - margin.left - margin.right);
  const innerH = Math.max(10, h - margin.top - margin.bottom);

  const svg = d3.select(svgEl)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`);

  svg.selectAll("*").remove();

  // Title
  svg.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Unique aircraft types per elevation group");

  const data = buildUniqueEquipmentByGroup(store, thresholds);

  if (!data.length) {
    svg.append("text")
      .attr("x", 14)
      .attr("y", 46)
      .attr("font-size", 12)
      .attr("fill", "#6b7280")
      .text("No equipment data available.");
    return;
  }

  //  Horizontal layout:
  // y = groups, x = unique count
  const ORDER = ["high", "mid", "low"];

  const y = d3.scaleBand()
    .domain(ORDER.filter(g => data.some(d => d.group === g)))
    .range([0, innerH])
    .padding(0.35);

  const x = d3.scaleLinear()
    .domain([0, d3.max(data, (d) => d.unique) || 1])
    .nice()
    .range([0, innerW]);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // Axes
  g.append("g")
    .call(d3.axisLeft(y).tickFormat(groupLabel))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 11))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(4))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 11))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  // X label
  svg.append("text")
    .attr("x", margin.left + innerW / 2)
    .attr("y", h - 3)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("Number of aircraft types");

  // Tooltip (HTML)
  const tip = d3.select(svgEl.parentElement)
    .selectAll("div._diversityTip")
    .data([null])
    .join("div")
    .attr("class", "_diversityTip")
    .style("position", "absolute")
    .style("pointer-events", "none")
    .style("display", "none")
    .style("background", "#111827")
    .style("color", "white")
    .style("padding", "8px 10px")
    .style("border-radius", "10px")
    .style("font-size", "12px")
    .style("opacity", "0.92");

  d3.select(svgEl.parentElement).style("position", "relative");

  function showTip(event, d) {
    tip.style("display", "block").html(
      `Group: <b>${groupLabel(d.group)}</b><br/>
       Unique types: <b>${d.unique}</b><br/>
       Routes: ${d.routes.toLocaleString()}`
    );
    moveTip(event);
  }

  function moveTip(event) {
    const [mx, my] = d3.pointer(event, svgEl.parentElement);
    tip.style("left", `${mx + 10}px`).style("top", `${my + 10}px`);
  }

  function hideTip() {
    tip.style("display", "none");
  }

  // Bars
  g.selectAll("rect.bar")
    .data(data)
    .join("rect")
    .attr("class", "bar")
    .attr("x", 0)
    .attr("y", (d) => y(d.group))
    .attr("width", (d) => x(d.unique))
    .attr("height", y.bandwidth())
    .attr("rx", 4)
    .attr("fill", (d) => elevationColor(d.group))
    .attr("opacity", 0.85)
    .on("mouseenter", function (event, d) {
      d3.select(this).attr("opacity", 1);
      showTip(event, d);
    })
    .on("mousemove", function (event) {
      moveTip(event);
    })
    .on("mouseleave", function () {
      d3.select(this).attr("opacity", 0.85);
      hideTip();
    });

  // Value labels on the right side of bars
  g.selectAll("text.val")
    .data(data)
    .join("text")
    .attr("class", "val")
    .attr("x", (d) => x(d.unique) + 6)
    .attr("y", (d) => y(d.group) + y.bandwidth() / 2 + 4)
    .attr("font-size", 10.5)
    .attr("fill", "#6b7280")
    .text((d) => d.unique);
}

async function renderSide(ctx) {
  const root = ctx.sideRoot;
  const svgEl = root?.querySelector("#elevation-chart-1");
  const svgE2 = root?.querySelector("#elevation-chart-2");
  const svgE3 = root?.querySelector("#elevation-chart-3");
  if (!svgEl || !svgE2 || !svgE3) return;

  const store = await initDataStore();

  if (!viewState.thresholds) {
    viewState.thresholds = computeElevationThresholds();
  }

  renderElevationScatter(svgEl, store, viewState.thresholds);
  renderEquipmentStackedBar(svgE2, store, viewState.thresholds);
  renderEquipmentDiversityBar(svgE3, store, viewState.thresholds);
}

export const elevation = { renderMap, renderSide };
