import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// js/distance.js
import {
  initDataStore,
  getFilteredRoutes,
  capRoutes,
  makeDistanceHistogram,
  countByDistanceClass,
} from "./utilities.js";

/**
 * Distance view (Emma):
 * - Map: show routes colored by short/mid/long distance classes
 * - Side: (1) distance histogram (2) class composition bar
 *
 * Assumptions:
 * - D3 is available (global `d3`)
 * - Side panel has containers with ids: #distance-chart-1 and #distance-chart-2
 */

const COLORS = {
  short: "#f2c14e", // warm yellow
  mid: "#f28c28",   // orange
  long: "#3b82f6",  // blue
};

const CLASS_LABEL = {
  short: "short-haul",
  mid: "mid-haul",
  long: "long-haul",
};

const MAP_ROUTE_LIMIT = 1200; // keep performance stable

// -------------- Map --------------
async function renderMap(ctx) {
  const { mapSvg: svg, width, height } = ctx;

  // load shared store once
  const store = await initDataStore();

  svg.selectAll("*").remove();

  // --- Background (sphere + graticule) ---
  const projection = d3.geoNaturalEarth1();
  projection.fitSize([width, height], { type: "Sphere" });

  const geoPath = d3.geoPath(projection);

  // sphere
  svg.append("path")
    .datum({ type: "Sphere" })
    .attr("d", geoPath)
    .attr("fill", "#f7fbff")
    .attr("stroke", "#d1d5db")
    .attr("stroke-width", 1);

  // graticule
  const graticule = d3.geoGraticule().step([30, 30]);
  svg.append("path")
    .datum(graticule())
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", "#e5e7eb")
    .attr("stroke-width", 0.8)
    .attr("opacity", 0.7);

  // --- Get filtered routes ---
  // Use global filters if you add UI later; currently defaults come from utilities.js state.
  const routesAll = getFilteredRoutes(store, store.state.filters);

  // For the map, cap to avoid overplotting (longFirst is best for teaching)
  const routes = capRoutes(routesAll, MAP_ROUTE_LIMIT, "longFirst");

  // --- Draw routes as great-circle arcs on the 2D projection ---
  // We use geoInterpolate to generate intermediate points on the sphere.
  const routesG = svg.append("g").attr("class", "distance-routes");

  // Light legend / labels
  drawLegend(svg);

  // Lines
  routesG.selectAll("path.route")
    .data(routes, (d, i) => `${d.src?.iata || "src"}-${d.dst?.iata || "dst"}-${i}`)
    .join("path")
    .attr("class", (d) => `route route-${d.distance_class}`)
    .attr("fill", "none")
    .attr("stroke", (d) => COLORS[d.distance_class] || "#94a3b8")
    .attr("stroke-opacity", 0.55)
    .attr("stroke-width", (d) => (d.distance_class === "long" ? 2.2 : d.distance_class === "mid" ? 1.7 : 1.2))
    .attr("d", (d) => {
      const line = greatCircleLineString(d.src, d.dst, 40); // 40 segments
      return geoPath(line);
    })
    .on("mouseenter", function (event, d) {
      d3.select(this)
        .attr("stroke-opacity", 0.95)
        .attr("stroke-width", 3);

      showTooltip(svg, event, formatRouteTooltip(d));
    })
    .on("mousemove", function (event) {
      moveTooltip(svg, event);
    })
    .on("mouseleave", function () {
      d3.select(this)
        .attr("stroke-opacity", 0.55)
        .attr("stroke-width", (d) => (d.distance_class === "long" ? 2.2 : d.distance_class === "mid" ? 1.7 : 1.2));
      hideTooltip(svg);
    });

  // Optional: show endpoints for the longest few routes (helps teaching)
  const endpoints = routes.slice(0, 60).flatMap((r) => [r.src, r.dst]);
  const unique = dedupeAirports(endpoints);

  svg.append("g")
    .attr("class", "distance-airports")
    .selectAll("circle.airport")
    .data(unique, (d) => d.iata || d.name)
    .join("circle")
    .attr("class", "airport")
    .attr("r", 2.5)
    .attr("fill", "#111827")
    .attr("opacity", 0.65)
    .attr("transform", (d) => {
      const p = projection([d.lon, d.lat]);
      return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
    })
    .append("title")
    .text((d) => `${d.name || d.iata || "Airport"} (${d.city || ""}${d.country ? ", " + d.country : ""})`);
}

// -------------- Side panel charts --------------
async function renderSide(ctx) {
  const store = await initDataStore();
  const routesAll = getFilteredRoutes(store, store.state.filters);

  const root = ctx.sideRoot;
  const el1 = root?.querySelector("#distance-chart-1");
  const el2 = root?.querySelector("#distance-chart-2");

  // If the HTML containers are missing, fail gracefully
  if (!el1 || !el2) return;

  // Clear
  el1.innerHTML = "";
  el2.innerHTML = "";

  // Chart 1: Histogram (Distance distribution)
  renderHistogram(el1, routesAll);

  // Chart 2: Class composition (short/mid/long)
  renderClassComposition(el2, routesAll);
}

// -------------- Helpers: great-circle + tooltip + charts --------------
function greatCircleLineString(src, dst, steps = 30) {
  const a = [src.lon, src.lat];
  const b = [dst.lon, dst.lat];
  const interp = d3.geoInterpolate(a, b);

  const coords = [];
  for (let i = 0; i <= steps; i++) coords.push(interp(i / steps));

  return { type: "LineString", coordinates: coords };
}

function formatRouteTooltip(d) {
  const from = d.src?.iata || d.src?.name || "Unknown";
  const to = d.dst?.iata || d.dst?.name || "Unknown";
  const km = Math.round(d.distance_km);
  const label = CLASS_LABEL[d.distance_class] || d.distance_class;
  return `${from} → ${to}\n${km} km (${label})`;
}

function renderHistogram(container, routes) {
  const w = Math.max(260, container.clientWidth || 300);
  const h = 170;
  const margin = { top: 18, right: 12, bottom: 28, left: 42 };
  const innerW = w - margin.left - margin.right;
  const innerH = h - margin.top - margin.bottom;

  const { bins, maxCount, min, max } = makeDistanceHistogram(routes, 28);

  const svg = d3.select(container)
    .append("svg")
    .attr("width", w)
    .attr("height", h);

  svg.append("text")
    .attr("x", 10)
    .attr("y", 16)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Distance distribution (km)");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear()
    .domain([min ?? 0, max ?? 1])
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, maxCount || 1])
    .nice()
    .range([innerH, 0]);

  // Bars
  g.selectAll("rect.bin")
    .data(bins)
    .join("rect")
    .attr("class", "bin")
    .attr("x", (d) => x(d.x0))
    .attr("y", (d) => y(d.count))
    .attr("width", (d) => Math.max(0, x(d.x1) - x(d.x0) - 1))
    .attr("height", (d) => innerH - y(d.count))
    .attr("fill", "#94a3b8")
    .attr("opacity", 0.7);

  // Axes
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat((d) => `${Math.round(d / 1000)}k`))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  g.append("g")
    .call(d3.axisLeft(y).ticks(4))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));
}

function renderClassComposition(container, routes) {
  const w = Math.max(260, container.clientWidth || 300);
  const h = 140;
  const margin = { top: 26, right: 12, bottom: 22, left: 12 };
  const innerW = w - margin.left - margin.right;
  const innerH = h - margin.top - margin.bottom;

  const counts = countByDistanceClass(routes);
  const total = Math.max(1, counts.short + counts.mid + counts.long);

  const parts = [
    { key: "short", value: counts.short, label: "short" },
    { key: "mid", value: counts.mid, label: "mid" },
    { key: "long", value: counts.long, label: "long" },
  ];

  const svg = d3.select(container)
    .append("svg")
    .attr("width", w)
    .attr("height", h);

  svg.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Short / Mid / Long share");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  let x0 = 0;
  for (const p of parts) {
    const segW = innerW * (p.value / total);

    g.append("rect")
      .attr("x", x0)
      .attr("y", 10)
      .attr("width", Math.max(0, segW))
      .attr("height", 18)
      .attr("fill", COLORS[p.key])
      .attr("opacity", 0.85);

    // label under
    g.append("text")
      .attr("x", x0 + segW / 2)
      .attr("y", 52)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("fill", "#6b7280")
      .text(`${p.label} (${Math.round((p.value / total) * 100)}%)`);

    x0 += segW;
  }

  // total count
  g.append("text")
    .attr("x", 0)
    .attr("y", 0)
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text(`n = ${total.toLocaleString()}`);
}

function drawLegend(svg) {
  const legend = svg.append("g").attr("class", "distance-legend")
    .attr("transform", "translate(16,16)");

  legend.append("rect")
    .attr("width", 220)
    .attr("height", 70)
    .attr("rx", 10)
    .attr("fill", "white")
    .attr("opacity", 0.9)
    .attr("stroke", "#e5e7eb");

  legend.append("text")
    .attr("x", 12)
    .attr("y", 20)
    .attr("font-size", 12)
    .attr("fill", "#111827")
    .attr("font-weight", 600)
    .text("Route distance classes");

  const items = [
    { key: "short", y: 40 },
    { key: "mid", y: 55 },
    { key: "long", y: 70 },
  ];

  for (const it of items) {
    legend.append("line")
      .attr("x1", 12)
      .attr("x2", 44)
      .attr("y1", it.y)
      .attr("y2", it.y)
      .attr("stroke", COLORS[it.key])
      .attr("stroke-width", it.key === "long" ? 3 : it.key === "mid" ? 2.4 : 2);

    legend.append("text")
      .attr("x", 52)
      .attr("y", it.y + 4)
      .attr("font-size", 11)
      .attr("fill", "#374151")
      .text(CLASS_LABEL[it.key]);
  }
}

// Tooltip (simple SVG foreignObject-free tooltip using SVG group)
function ensureTooltip(svg) {
  let tip = svg.select("g._tooltip");
  if (!tip.empty()) return tip;

  tip = svg.append("g")
    .attr("class", "_tooltip")
    .style("display", "none");

  tip.append("rect")
    .attr("class", "_tooltip-bg")
    .attr("rx", 8)
    .attr("fill", "#111827")
    .attr("opacity", 0.9);

  tip.append("text")
    .attr("class", "_tooltip-text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "white");

  return tip;
}

function showTooltip(svg, event, text) {
  const tip = ensureTooltip(svg);
  const t = tip.select("text._tooltip-text");
  t.selectAll("tspan").remove();

  const lines = String(text).split("\n");
  lines.forEach((line, i) => {
    t.append("tspan")
      .attr("x", 10)
      .attr("dy", i === 0 ? 0 : 16)
      .text(line);
  });

  const bbox = t.node().getBBox();
  tip.select("rect._tooltip-bg")
    .attr("width", bbox.width + 20)
    .attr("height", bbox.height + 14);

  tip.style("display", null);
  moveTooltip(svg, event);
}

function moveTooltip(svg, event) {
  const tip = svg.select("g._tooltip");
  if (tip.empty()) return;

  const [mx, my] = d3.pointer(event, svg.node());
  tip.attr("transform", `translate(${mx + 12},${my + 12})`);
}

function hideTooltip(svg) {
  svg.select("g._tooltip").style("display", "none");
}

function dedupeAirports(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = a?.iata || a?.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// -------------- Export --------------
export const distance = { renderMap, renderSide };
