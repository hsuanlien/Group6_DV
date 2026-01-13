import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

import { initDataStore } from "./utilities.js";

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
function computeElevationThresholds(airports) {
  // Use quantiles to split into 3 balanced groups.
  const alts = airports
    .map((a) => a.altitude)
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);

  if (alts.length < 10) {
    // fallback if dataset is tiny
    return { q1: 500, q2: 2000 };
  }

  const q1 = d3.quantileSorted(alts, 1 / 3);
  const q2 = d3.quantileSorted(alts, 2 / 3);

  // Guard if quantiles degenerate
  const safeQ1 = Number.isFinite(q1) ? q1 : 500;
  const safeQ2 = Number.isFinite(q2) ? q2 : 2000;

  return { q1: safeQ1, q2: safeQ2 };
}

function elevationGroup(altFt, thresholds) {
  if (altFt == null || !Number.isFinite(altFt)) return null;
  if (altFt <= thresholds.q1) return "low";
  if (altFt <= thresholds.q2) return "mid";
  return "high";
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
  if (group === "low") groupLabel = `Low (≤ ${fmtFeet(thresholds.q1)})`;
  if (group === "mid") groupLabel = `Mid (${fmtFeet(thresholds.q1)} – ${fmtFeet(thresholds.q2)})`;
  if (group === "high") groupLabel = `High (> ${fmtFeet(thresholds.q2)})`;

  const alt = fmtFeet(a.altitude) + fmtMetersFromFeet(a.altitude);

  return `${name}${iata}${city}${country}\nAltitude: ${alt}\nGroup: ${groupLabel}`;
}

// -------------------------
// legend
// -------------------------
function drawElevationLegend(svg, geoPath, thresholds) {
  const boxW = 165;
  const boxH = 110;

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
    .text("Cutoffs use altitude quantiles");

  const rows = [
    { label: `High (> ${fmtFeet(thresholds.q2)})`, color: HIGH_COLOR },
    { label: `Mid (${fmtFeet(thresholds.q1)} – ${fmtFeet(thresholds.q2)})`, color: MID_COLOR },
    { label: `Low (≤ ${fmtFeet(thresholds.q1)})`, color: LOW_COLOR },
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

  // counts[group][equipment] = count
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

    // If no equipment, bucket as "Unknown"
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

  // build stacked rows: one row per elevation group
  const groups = ["low", "mid", "high"];
  const rows = groups.map((g) => {
    const row = { group: g };
    for (const k of KEYS) row[k] = 0;

    for (const [eq, c] of counts[g].entries()) {
      if (top.includes(eq)) row[eq] += c;
      else row["Other"] += c;
    }
    return row;
  });

  return { rows, keys: KEYS };
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

  svg.selectAll("*").remove();

  const projection = d3.geoNaturalEarth1()
    .scale(125)                    // 👈 fixed globe size
    .translate([width / 2 - 14, height / 2 + 45]); // center in panel
  const geoPath = d3.geoPath(projection);

  // Sphere
  svg.append("path")
    .datum({ type: "Sphere" })
    .attr("d", geoPath)
    .attr("fill", SPHERE_FILL)
    .attr("stroke", "#d1d5db")
    .attr("stroke-width", 1);

  // Land + borders (same)
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

  // Graticule (same)
  const graticule = d3.geoGraticule().step([30, 30]);
  svg.append("path")
    .datum(graticule())
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", GRID_STROKE)
    .attr("stroke-width", 0.8)
    .attr("opacity", 0.55);

  // For tooltip clamp region
  const sphereBounds = geoPath.bounds({ type: "Sphere" });
  svg.property("__sphereBounds__", sphereBounds);

  // Elevation thresholds (cached per view)
  if (!viewState.thresholds) {
    viewState.thresholds = computeElevationThresholds(store.airports || []);
  }
  const thresholds = viewState.thresholds;

  ensureMapTooltip(svg);

  // Draw airport dots
  const airports = (store.airports || []).filter(
    (a) => Number.isFinite(a.lat) && Number.isFinite(a.lon)
  );

  const dotsG = svg.append("g").attr("class", "elev-airports");

  const points = dotsG
    .selectAll("circle.airport")
    .data(airports, (d) => d.iata || `${d.name}-${d.lat}-${d.lon}`)
    .join("circle")
    .attr("class", "airport")
    .attr("r", DOT_R)
    .attr("fill", (a) => elevationColor(elevationGroup(a.altitude, thresholds)))
    .attr("opacity", DOT_OPACITY)
    .attr("stroke", DOT_STROKE)
    .attr("stroke-width", DOT_STROKE_W)
    .attr("transform", (a) => {
      const p = projection([a.lon, a.lat]);
      return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
    })
    .on("mouseenter", function (event, a) {
      const group = elevationGroup(a.altitude, thresholds);
      d3.select(this).attr("opacity", 1).raise();
      showMapTooltip(svg, event, formatAirportTooltip(a, group, thresholds));
    })
    .on("mousemove", function (event) {
      moveMapTooltip(svg, event);
    })
    .on("mouseleave", function () {
      d3.select(this).attr("opacity", DOT_OPACITY);
      hideMapTooltip(svg);
    });

  viewState.pointsSel = points;

  // Legend
  drawElevationLegend(svg, geoPath, thresholds);
}

function getChartSize(svgEl, fallbackW = 420, fallbackH = 260) {
  const parent = svgEl.parentElement;
  const rect = parent ? parent.getBoundingClientRect() : null;
  const w = rect?.width ? Math.floor(rect.width) : fallbackW;
  const h = rect?.height ? Math.floor(rect.height) : fallbackH;
  return { w, h };
}

function computeRouteCountsByAirport(routesDerived) {
  const m = new Map();

  for (const r of routesDerived) {
    const s = r?.src?.iata;
    const d = r?.dst?.iata;

    // count both endpoints (connectivity).
    // If you want departures only: keep only the src block.
    if (s) m.set(s, (m.get(s) ?? 0) + 1);
    if (d) m.set(d, (m.get(d) ?? 0) + 1);
  }

  return m;
}

function buildEquipmentDistributionForGroup(store, thresholds, targetGroup = "high", topK = 6) {
  const routes = store.routesDerived || [];
  const counts = new Map();

  for (const r of routes) {
    const alt = r?.src?.altitude;
    if (!Number.isFinite(alt)) continue;

    const g = elevationGroup(alt, thresholds);
    if (g !== targetGroup) continue;

    const eqList = parseEquipmentList(r.equipment);
    const finalList = eqList.length ? eqList : ["Unknown"];

    for (const eq of finalList) {
      counts.set(eq, (counts.get(eq) ?? 0) + 1);
    }
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topK);
  const rest = sorted.slice(topK);

  const other = rest.reduce((acc, [, v]) => acc + v, 0);
  const items = top.map(([k, v]) => ({ key: k, value: v }));

  if (other > 0) items.push({ key: "Other", value: other });

  const total = items.reduce((s, d) => s + d.value, 0);
  return { items, total };
}

function renderElevationScatter(svgEl, store, thresholds) {
  const { w, h } = getChartSize(svgEl, 460, 320);

  const margin = {
    top: 24,
    right: 12,
    bottom: Math.max(34, Math.round(h * 0.18)), // scale with height
    left: Math.max(46, Math.round(w * 0.12)),   // scale with width
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

  // Build data: join airport altitude + route count
  const routeCount = computeRouteCountsByAirport(store.routesDerived || []);

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
    .attr("y", h - 10)
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
    .style("font-size", "12px")
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
  g.append("g")
    .selectAll("circle")
    .data(data)
    .join("circle")
    .attr("cx", (d) => x(d.altitude))
    .attr("cy", (d) => y(d.routes))
    .attr("r", 2.5)
    .attr("fill", (d) => elevationColor(d.group))
    .attr("opacity", 0.8)
    .attr("stroke", "white")
    .attr("stroke-width", 0.6)
    .on("mouseenter", function (event, d) {
      d3.select(this).attr("opacity", 1).attr("r", 4.2).raise();
      showTip(event, d);
    })
    .on("mousemove", function (event) {
      moveTip(event);
    })
    .on("mouseleave", function () {
      d3.select(this).attr("opacity", 0.7).attr("r", 3.2);
      hideTip();
    });
}

function renderEquipmentStackedBar(svgEl, store, thresholds) {
  const { w, h } = getChartSize(svgEl, 460, 180);

  const margin = {
    top: 26,
    right: 12,
    bottom: 34,
    left: 44,
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
    .text("Aircraft types by altitude group");

  const { rows, keys } = buildEquipmentStackData(store, thresholds, 7);
  if (!rows.length) return;

  const groups = rows.map((d) => d.group);

  const stack = d3.stack().keys(keys);
  const series = stack(rows);

  const maxY = d3.max(series, (s) => d3.max(s, (d) => d[1])) || 1;

  const x = d3.scaleBand()
    .domain(groups)
    .range([0, innerW])
    .padding(0.35);

  const y = d3.scaleLinear()
    .domain([0, maxY])
    .nice()
    .range([innerH, 0]);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  // Axes
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickFormat(groupLabel))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 11))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  g.append("g")
    .call(d3.axisLeft(y).ticks(4))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 11))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  // Y label
  svg.append("text")
    .attr("transform", `translate(14, ${margin.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("Number of routes");

  // Tooltip (simple)
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

  // Draw stacks
  const layers = g.append("g")
    .selectAll("g.layer")
    .data(series)
    .join("g")
    .attr("class", "layer")
    .attr("fill", (d) => {
      // Use your elevation colors for groups? No—these are equipment categories.
      // Keep default palette from D3 (no manual colors) to differentiate equipment.
      return d3.schemeTableau10[keys.indexOf(d.key) % 10];
    });

  layers.selectAll("rect")
    .data((d) => d.map((v) => ({ key: d.key, v })))
    .join("rect")
    .attr("x", (d) => x(d.v.data.group))
    .attr("width", x.bandwidth())
    .attr("y", (d) => y(d.v[1]))
    .attr("height", (d) => Math.max(0, y(d.v[0]) - y(d.v[1])))
    .attr("opacity", 0.85)
    .on("mouseenter", function (event, d) {
      const gKey = groupLabel(d.v.data.group);
      const val = d.v.data[d.key] ?? 0;
      showTip(event, `<b>${gKey}</b><br/>${d.key}: ${val.toLocaleString()}`);
      d3.select(this).attr("opacity", 1);
    })
    .on("mousemove", function (event) {
      moveTip(event);
    })
    .on("mouseleave", function () {
      hideTip();
      d3.select(this).attr("opacity", 0.85);
    });

  // Small legend (compact, top-left inside chart)
  const leg = svg.append("g").attr("transform", `translate(${margin.left},${margin.top - 6})`);
  const legendKeys = keys.slice(0, Math.min(keys.length, 5)); // keep compact
  leg.selectAll("g")
    .data(legendKeys)
    .join("g")
    .attr("transform", (d, i) => `translate(${i * 78},0)`)
    .each(function (k) {
      const gg = d3.select(this);
      gg.append("rect")
        .attr("x", 0)
        .attr("y", -10)
        .attr("width", 10)
        .attr("height", 10)
        .attr("fill", d3.schemeTableau10[keys.indexOf(k) % 10])
        .attr("opacity", 0.85);

      gg.append("text")
        .attr("x", 14)
        .attr("y", -1)
        .attr("font-size", 10.5)
        .attr("fill", "#6b7280")
        .text(k.length > 8 ? k.slice(0, 7) + "…" : k);
    });
}

function renderEquipmentPie(svgEl, store, thresholds) {
  const { w, h } = getChartSize(svgEl, 460, 180);

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
    .text("Aircraft types (high-altitude airports)");

  const { items, total } = buildEquipmentDistributionForGroup(store, thresholds, "high", 6);

  if (!items.length || total === 0) {
    svg.append("text")
      .attr("x", 14)
      .attr("y", 46)
      .attr("font-size", 12)
      .attr("fill", "#6b7280")
      .text("No route equipment data for high-altitude airports.");
    return;
  }

  // Layout: donut on left, legend on right
  const pad = 10;
  const legendW = Math.min(170, Math.floor(w * 0.42));
  const chartW = w - legendW - pad;

  const cx = Math.max(60, Math.floor(chartW * 0.50));
  const cy = Math.max(70, Math.floor(h * 0.56));

  const r = Math.max(34, Math.min(Math.floor(h * 0.34), Math.floor(chartW * 0.34)));
  const innerR = Math.max(18, Math.floor(r * 0.58));

  const color = d3.scaleOrdinal()
    .domain(items.map((d) => d.key))
    .range(d3.schemeTableau10);

  const pie = d3.pie().sort(null).value((d) => d.value);
  const arc = d3.arc().outerRadius(r).innerRadius(innerR);
  const arcHover = d3.arc().outerRadius(r + 4).innerRadius(innerR);

  // Tooltip (HTML)
  const tip = d3.select(svgEl.parentElement)
    .selectAll("div._pieTip")
    .data([null])
    .join("div")
    .attr("class", "_pieTip")
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
    const pct = total ? Math.round((d.data.value / total) * 1000) / 10 : 0;
    tip.style("display", "block").html(
      `<b>${d.data.key}</b><br/>Routes: ${d.data.value.toLocaleString()}<br/>Share: ${pct}%`
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

  // Donut group
  const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

  g.selectAll("path.slice")
    .data(pie(items))
    .join("path")
    .attr("class", "slice")
    .attr("d", arc)
    .attr("fill", (d) => color(d.data.key))
    .attr("opacity", 0.9)
    .attr("stroke", "white")
    .attr("stroke-width", 1)
    .on("mouseenter", function (event, d) {
      d3.select(this).attr("d", arcHover).attr("opacity", 1);
      showTip(event, d);
    })
    .on("mousemove", function (event) {
      moveTip(event);
    })
    .on("mouseleave", function () {
      d3.select(this).attr("d", arc).attr("opacity", 0.9);
      hideTip();
    });

  // Center label (total)
  g.append("text")
    .attr("text-anchor", "middle")
    .attr("y", -2)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 700)
    .text(total.toLocaleString());

  g.append("text")
    .attr("text-anchor", "middle")
    .attr("y", 14)
    .attr("font-size", 10.5)
    .attr("fill", "#6b7280")
    .text("routes");

  // Legend (right side)
  const legX = chartW + 6;
  const legY = 34;

  const leg = svg.append("g").attr("transform", `translate(${legX},${legY})`);

  const rowH = 16;
  const maxRows = Math.floor((h - legY - 10) / rowH);
  const legendItems = items.slice(0, Math.max(1, maxRows));

  leg.selectAll("g.row")
    .data(legendItems)
    .join("g")
    .attr("class", "row")
    .attr("transform", (d, i) => `translate(0,${i * rowH})`)
    .each(function (d) {
      const row = d3.select(this);

      row.append("rect")
        .attr("x", 0)
        .attr("y", -10)
        .attr("width", 10)
        .attr("height", 10)
        .attr("fill", color(d.key))
        .attr("opacity", 0.9);

      const pct = total ? Math.round((d.value / total) * 1000) / 10 : 0;

      row.append("text")
        .attr("x", 14)
        .attr("y", -1)
        .attr("font-size", 10.5)
        .attr("fill", "#6b7280")
        .text(`${d.key.length > 10 ? d.key.slice(0, 9) + "…" : d.key} (${pct}%)`);
    });
}

async function renderSide(ctx) {
  const root = ctx.sideRoot;
  const svgEl = root?.querySelector("#elevation-chart-1");
  const svgE2 = root?.querySelector("#elevation-chart-2");
  const svgE3 = root?.querySelector("#elevation-chart-3");
  if (!svgEl || !svgE2 || !svgE3) return;

  const store = await initDataStore();

  if (!viewState.thresholds) {
    viewState.thresholds = computeElevationThresholds(store.airports || []);
  }

  renderElevationScatter(svgEl, store, viewState.thresholds);
  renderEquipmentStackedBar(svgE2, store, viewState.thresholds);
  renderEquipmentPie(svgE3, store, viewState.thresholds);
}

export const elevation = { renderMap, renderSide };
