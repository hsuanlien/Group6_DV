import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

import {
  initDataStore,
  getFilteredRoutes,
  makeDistanceHistogram,
  countByDistanceClass,
} from "./utilities.js";

// --- Distance class thresholds (km) ---
const DISTANCE_BINS = { shortMax: 1500, midMax: 4000 };

// --- Styling ---
const COLORS = {
  short: "#f2c14e", // light orange
  mid: "#f28c28",   // dark orange
  long: "#3b82f6",  // blue
};

const CLASS_LABEL = { short: "short-haul", mid: "mid-haul", long: "long-haul" };

// Default route style (neutral)
const DEFAULT_ROUTE_COLOR = "#1f4b99";
const DEFAULT_ROUTE_OPACITY = 0.35;
const FADED_ROUTE_OPACITY = 0.10;

const MAP_ROUTE_LIMIT = 1200;

// --- Basemap cache ---
const WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
let _worldTopo = null;
let _land = null;
let _borders = null;

async function loadWorldLayers() {
  if (_land && _borders) return { land: _land, borders: _borders };
  if (!_worldTopo) _worldTopo = await d3.json(WORLD_ATLAS_URL);

  const countries = _worldTopo.objects.countries;
  _land = topojson.feature(_worldTopo, countries);
  _borders = topojson.mesh(_worldTopo, countries, (a, b) => a !== b);

  return { land: _land, borders: _borders };
}

/**
 * ✅ Shared view state (for cross-highlighting)
 * renderMap() 和 renderSide() 分開呼叫，所以要靠 module-level state 共享 selection
 */
const viewState = {
  routesForView: [],      // SAME routes used by map & charts
  routesSel: null,        // d3 selection of paths
  histBins: [],           // histogram bins
  histRectsSel: null,     // selection of histogram rects
  shareSegSel: null,      // selection of share segments

  // ✅ NEW: brush state
  histXScale: null,       // x scale used in histogram (for invert)
  brushRangeKm: null,     // [minKm, maxKm] or null
};


// ----------------------
// Sampling (fix mismatch)
// ----------------------
function sampleRoutesStratified(routesAll, limit) {
  if (routesAll.length <= limit) return routesAll;

  // count by class
  const counts = countByDistanceClass(routesAll);
  const total = routesAll.length;

  // allocate quotas proportional to distribution
  const quota = {
    short: Math.max(1, Math.round((counts.short / total) * limit)),
    mid: Math.max(1, Math.round((counts.mid / total) * limit)),
    long: Math.max(1, Math.round((counts.long / total) * limit)),
  };

  // fix rounding drift
  let sumQ = quota.short + quota.mid + quota.long;
  while (sumQ > limit) {
    if (quota.long > 1) quota.long--;
    else if (quota.mid > 1) quota.mid--;
    else quota.short--;
    sumQ--;
  }
  while (sumQ < limit) {
    quota.short++;
    sumQ++;
  }

  // shuffle each class and take quota
  const byClass = {
    short: routesAll.filter(r => r.distance_class === "short"),
    mid: routesAll.filter(r => r.distance_class === "mid"),
    long: routesAll.filter(r => r.distance_class === "long"),
  };

  for (const k of ["short", "mid", "long"]) byClass[k] = d3.shuffle(byClass[k]);

  return [
    ...byClass.short.slice(0, quota.short),
    ...byClass.mid.slice(0, quota.mid),
    ...byClass.long.slice(0, quota.long),
  ];
}

// ----------------------
// Map
// ----------------------
async function renderMap(ctx) {
  const { mapSvg: svg, width, height } = ctx;
  const store = await initDataStore();

  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  // --- projection/path ---
  const projection = d3.geoNaturalEarth1()
    .scale(125)
    .translate([width / 2 - 14, height / 2 + 45]);
  const geoPath = d3.geoPath(projection);

  // =========================
  // ✅ 1) 建立 zoom root group
  // =========================
  const zoomG = svg.append("g").attr("class", "zoom-root");

  // =========================
  // ✅ 2) basemap 都畫在 zoomG
  // =========================

  // sphere
  zoomG.append("path")
    .datum({ type: "Sphere" })
    .attr("d", geoPath)
    .attr("fill", "#f7fbff")
    .attr("stroke", "#d1d5db")
    .attr("stroke-width", 1);

  // land + borders
  const { land, borders } = await loadWorldLayers();

  zoomG.append("path")
    .datum(land)
    .attr("d", geoPath)
    .attr("fill", "#dde5ee")
    .attr("stroke", "none")
    .attr("opacity", 1);

  zoomG.append("path")
    .datum(borders)
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", "#c7d0dc")
    .attr("stroke-width", 0.7)
    .attr("opacity", 0.95);

  // graticule
  const graticule = d3.geoGraticule().step([30, 30]);
  zoomG.append("path")
    .datum(graticule())
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", "#e5e7eb")
    .attr("stroke-width", 0.8)
    .attr("opacity", 0.6);

  // =========================
  // 3) routes (filtered + stratified)
  // =========================
  const routesAll = getFilteredRoutes(store, store.state.filters);
  const countsAll = countByDistanceClass(routesAll);
  console.log("FULL (routesAll) total:", routesAll.length, countsAll);

  const routes = sampleRoutesStratified(routesAll, MAP_ROUTE_LIMIT); // 抽樣後
  const countsSample = countByDistanceClass(routes);
  console.log("SAMPLE (routes) total:", routes.length, countsSample);

  viewState.routesForView = routes;

  // legend 不要跟著 zoom（所以放在 svg，而不是 zoomG）
  drawLegend(svg, width, height);

  const routesG = zoomG.append("g").attr("class", "distance-routes");

  const routesSel = routesG.selectAll("path.route")
    .data(routes, (d, i) => `${d.src?.iata || "src"}-${d.dst?.iata || "dst"}-${i}`)
    .join("path")
    .attr("class", (d) => `route route-${d.distance_class}`)
    .attr("fill", "none")
    .attr("stroke", DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
    .attr("stroke-width", 1.6)
    .attr("d", (d) => geoPath(greatCircleLineString(d.src, d.dst, 40)))
    .style("cursor", "pointer")
    .on("mouseenter", function (event, d) {
      routesSel
        .attr("stroke", DEFAULT_ROUTE_COLOR)
        .attr("stroke-opacity", FADED_ROUTE_OPACITY)
        .attr("stroke-width", 1.1);

      d3.select(this)
        .raise()
        .attr("stroke", COLORS[d.distance_class] || DEFAULT_ROUTE_COLOR)
        .attr("stroke-opacity", 0.95)
        .attr("stroke-width", 3.2);

      showTooltip(svg, event, formatRouteTooltip(d));
      highlightHistogramByDistance(d.distance_km);
    })
    .on("mousemove", function (event) {
      moveTooltip(svg, event);
    })
    .on("mouseleave", function () {
      routesSel
        .attr("stroke", DEFAULT_ROUTE_COLOR)
        .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
        .attr("stroke-width", 1.6);

      hideTooltip(svg);
      clearHistogramHighlight();
    })
    // ✅ (可選) click 讓使用者「選中」路徑
    .on("click", function (event, d) {
      event.stopPropagation();
      routesSel
        .attr("stroke", DEFAULT_ROUTE_COLOR)
        .attr("stroke-opacity", FADED_ROUTE_OPACITY)
        .attr("stroke-width", 1.1);

      d3.select(this)
        .raise()
        .attr("stroke", COLORS[d.distance_class] || DEFAULT_ROUTE_COLOR)
        .attr("stroke-opacity", 1)
        .attr("stroke-width", 3.6);

      showTooltip(svg, event, formatRouteTooltip(d));
    });

  viewState.routesSel = routesSel;

  // =========================
  //  4) airports 點：改成從「全部 routes」抽端點，並 cap 數量
  // =========================
  const endpointsAll = routes.flatMap((r) => [r.src, r.dst]);
  const uniqueAll = dedupeAirports(endpointsAll);

  // 太多點會影響效能/可視覺：cap
  // const MAX_AIRPORT_DOTS = 250;
  // const airportsToShow = uniqueAll.length > MAX_AIRPORT_DOTS
  //   ? d3.shuffle(uniqueAll).slice(0, MAX_AIRPORT_DOTS)
  //   : uniqueAll;
  const airportsToShow = uniqueAll; // ✅ 顯示所有端點


  zoomG.append("g")
    .attr("class", "distance-airports")
    .selectAll("circle.airport")
    .data(airportsToShow, (d) => d.iata || d.name)
    .join("circle")
    .attr("class", "airport")
    .attr("r", 1.5)
    .attr("fill", "#111827")
    .attr("opacity", 0.3)
    .style("pointer-events", "none") 
    .attr("transform", (d) => {
      const p = projection([d.lon, d.lat]);
      return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
    });

  // =========================
  // 5) zoom 行為 + 按鈕
  // =========================
  const zoom = d3.zoom()
    .scaleExtent([1, 8])
    .on("zoom", (event) => {
      zoomG.attr("transform", event.transform);
    });

  // 讓滑鼠滾輪/拖曳可以 zoom/pan
  svg.call(zoom);

  // 點空白處：取消選中、回到預設樣式（可選）
  svg.on("click", () => {
    routesSel
      .attr("stroke", DEFAULT_ROUTE_COLOR)
      .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
      .attr("stroke-width", 1.6);
    hideTooltip(svg);
  });

}

// ----------------------
// Side panel charts
// ----------------------
async function renderSide(ctx) {
  const root = ctx.sideRoot;
  const svg1 = root?.querySelector("#distance-chart-1");
  const svg2 = root?.querySelector("#distance-chart-2");
  if (!svg1 || !svg2) return;
  const svgEl = root?.querySelector("#curvature-chart-1");
  if (!svgEl) return;
  // ✅ 只調 curvature 這張圖的外框高度（不影響其他頁）
  const slot = svgEl.closest(".chart-slot");
  if (slot) slot.style.height = "300px"; // 你可試 220/240/260


  d3.select(svg1).selectAll("*").remove();
  d3.select(svg2).selectAll("*").remove();

  // ✅ charts use SAME routes as map
  const routes = viewState.routesForView;

  renderHistogram(svg1, routes);
  renderClassComposition(svg2, routes);
}

// ----------------------
// Helpers
// ----------------------
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

function getChartSize(svgEl, fallbackW = 360, fallbackH = 170) {
  const parent = svgEl.parentElement;
  const rect = parent ? parent.getBoundingClientRect() : null;
  const w = rect?.width ? Math.floor(rect.width) : fallbackW;
  const h = rect?.height ? Math.floor(rect.height) : fallbackH;
  return { w, h };
}

// ----------------------
// Histogram (with highlight)
// ----------------------
function renderHistogram(svgEl, routes) {
  const { w, h } = getChartSize(svgEl, 360, 170);
  //const margin = { top: 50, right: 12, bottom: 30, left: 52 };
  const margin = { top: 52, right: 14, bottom: 58, left: 58 };

  const innerW = w - margin.left - margin.right;
  const innerH = h - margin.top - margin.bottom;

  const { bins, maxCount, min, max } = makeDistanceHistogram(routes, 28);
  viewState.histBins = bins;

  const svg = d3.select(svgEl)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`);

  svg.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Distance distribution (km)");

  // ✅ show selected range text
  const rangeText = svg.append("text")
    .attr("class", "brush-range-text")
    .attr("x", w - 10)
    .attr("y", 18)
    .attr("text-anchor", "end")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text(viewState.brushRangeKm ? `${Math.round(viewState.brushRangeKm[0])}–${Math.round(viewState.brushRangeKm[1])} km` : "Drag to filter");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain([min ?? 0, max ?? 1]).range([0, innerW]);
  const y = d3.scaleLinear().domain([0, maxCount || 1]).nice().range([innerH, 0]);

  // ✅ store x scale for brush inversion
  viewState.histXScale = x;

  const rects = g.selectAll("rect.bin")
    .data(bins)
    .join("rect")
    .attr("class", "bin")
    .attr("x", (d) => x(d.x0))
    .attr("y", (d) => y(d.count))
    .attr("width", (d) => Math.max(0, x(d.x1) - x(d.x0) - 1))
    .attr("height", (d) => innerH - y(d.count))
    .attr("fill", "#94a3b8")
    .attr("opacity", 0.75);

  viewState.histRectsSel = rects;

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat((d) => `${Math.round(d / 1000)}k`))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  // g.append("g")
  //   .call(d3.axisLeft(y).ticks(4))
  //   .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
  //   .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));
  // g.append("g")
  // .call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${Math.round(d / 1000)}k`).tickPadding(6))
  // .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
  // .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));
g.append("g")
  .call(d3.axisLeft(y).ticks(3).tickFormat((d) => `${Math.round(d / 1000)}k`).tickPadding(6))
  .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 10))
  .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));


  // ----------------------------
  // ✅ NEW: Brush interaction
  // ----------------------------
  const brush = d3.brushX()
    .extent([[0, 0], [innerW, innerH]])
    .on("brush end", (event) => {
      if (!event.selection) {
        // cleared
        viewState.brushRangeKm = null;
        rangeText.text("Drag to filter");
        updateHistogramBrushStyle();
        applyBrushToMap();
        return;
      }

      const [px0, px1] = event.selection;
      const km0 = x.invert(px0);
      const km1 = x.invert(px1);

      const minKm = Math.max(0, Math.min(km0, km1));
      const maxKm = Math.max(0, Math.max(km0, km1));

      viewState.brushRangeKm = [minKm, maxKm];
      rangeText.text(`${Math.round(minKm)}–${Math.round(maxKm)} km`);

      updateHistogramBrushStyle();
      applyBrushToMap();
    });

  g.append("g")
    .attr("class", "brush")
    .call(brush);

  // ✅ if there is existing brush range (e.g. rerender), restore it
  if (viewState.brushRangeKm) {
    const [minKm, maxKm] = viewState.brushRangeKm;
    g.select("g.brush").call(brush.move, [x(minKm), x(maxKm)]);
    updateHistogramBrushStyle();
  }
}


function highlightHistogramByDistance(km) {
  const rects = viewState.histRectsSel;
  const bins = viewState.histBins;
  if (!rects || !bins?.length || km == null) return;

  // find bin index
  const idx = bins.findIndex((b) => km >= b.x0 && km < b.x1);
  if (idx < 0) return;

  rects
    .attr("opacity", (d, i) => (i === idx ? 1 : 0.25))
    .attr("fill", (d, i) => (i === idx ? "#64748b" : "#cbd5e1"));
}

function clearHistogramHighlight() {
  const rects = viewState.histRectsSel;
  if (!rects) return;
  rects.attr("opacity", 0.75).attr("fill", "#94a3b8");
}

// ----------------------
// Share bar (hover -> highlight routes)
// ----------------------
function renderClassComposition(svgEl, routes) {
  const { w, h } = getChartSize(svgEl, 360, 140);
  const margin = { top: 28, right: 12, bottom: 36, left: 12 };
  const innerW = w - margin.left - margin.right;

  const counts = countByDistanceClass(routes);
  const total = routes.length;

  const parts = [
    { key: "short", value: counts.short || 0 },
    { key: "mid", value: counts.mid || 0 },
    { key: "long", value: counts.long || 0 },
  ];

  const svg = d3.select(svgEl)
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`);

  svg.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Short / Mid / Long percentage");

  svg.append("text")
    .attr("x", 10)
    .attr("y", 34)
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text(`n = ${total.toLocaleString()}`);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("rect")
    .attr("x", 0)
    .attr("y", 12)
    .attr("width", innerW)
    .attr("height", 18)
    .attr("fill", "#eef2f7");

  let x0 = 0;

  const segs = g.selectAll("rect.seg")
    .data(parts)
    .join("rect")
    .attr("class", "seg")
    .attr("x", (p) => {
      const xStart = x0;
      const segW = total > 0 ? innerW * (p.value / total) : 0;
      x0 += segW;
      return xStart;
    })
    .attr("y", 12)
    .attr("width", (p) => (total > 0 ? innerW * (p.value / total) : 0))
    .attr("height", 18)
    .attr("fill", (p) => COLORS[p.key])
    .attr("opacity", 0.85)
    .on("mouseenter", (event, p) => {
      highlightRoutesByClass(p.key);
    })
    .on("mouseleave", () => {
      clearRouteHighlight();
    });

  viewState.shareSegSel = segs;

  // labels
  let cum = 0;
  for (const p of parts) {
    const segW = total > 0 ? innerW * (p.value / total) : 0;
    const pct = total > 0 ? Math.round((p.value / total) * 100) : 0;

    g.append("text")
      .attr("x", cum + segW / 2)
      .attr("y", 58)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("fill", "#6b7280")
      .text(`${p.key} (${pct}%)`);

    cum += segW;
  }
}

function highlightRoutesByClass(classKey) {
  const routesSel = viewState.routesSel;
  if (!routesSel) return;

  routesSel
    .attr("stroke", DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", FADED_ROUTE_OPACITY)
    .attr("stroke-width", 1.1);

  routesSel
    .filter((d) => d.distance_class === classKey)
    .raise()
    .attr("stroke", COLORS[classKey] || DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", 0.95)
    .attr("stroke-width", 3.0);
}

function clearRouteHighlight() {
  const routesSel = viewState.routesSel;
  if (!routesSel) return;

  routesSel
    .attr("stroke", DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
    .attr("stroke-width", 1.6);
}

// ----------------------
// Legend
// ----------------------
function drawLegend(svg, width, height) {
  // ✅ 統一尺寸，避免切換時左邊緣跳動
  const boxW = 250;   // 原本 230
  const boxH = 92;    // 原本 90
  // ✅ 跟 hubs 一樣的 padding 設定
   // ✅ 跟 hubs 一樣的 padding 設定
  const topPad = 2;
  const rightPad = 6;

  // ✅ 先清掉舊 legend，避免每次 render 疊加
  svg.selectAll("g.distance-legend").remove();

  // ✅ 用 SVG viewport 寬度（跟 hubs 一樣）
  const svgW = +svg.attr("width");      // 你指定要用這種方式
  // const svgH = +svg.attr("height");  // 目前 y 用 topPad，不一定需要

  // ✅ 跟 hubs 一樣：右上角定位 + 額外往左推 20px
  const x = Math.max(0, svgW - boxW - rightPad - 20);
  const y = Math.max(0, topPad);

  const g = svg.append("g")
    .attr("class", "distance-legend")
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
    .text("Route distance classes");

  g.append("text")
    .attr("x", 12)
    .attr("y", 36)
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text(`short<${DISTANCE_BINS.shortMax}  mid<${DISTANCE_BINS.midMax}  long≥${DISTANCE_BINS.midMax} (km)`);

  const items = [
    { key: "short", y: 50 },
    { key: "mid", y: 62 },
    { key: "long", y: 74 },
  ];

  for (const it of items) {
    g.append("line")
      .attr("x1", 12)
      .attr("x2", 42)
      .attr("y1", it.y)
      .attr("y2", it.y)
      .attr("stroke", COLORS[it.key])
      .attr("stroke-width", it.key === "long" ? 3 : it.key === "mid" ? 2.4 : 2);

    g.append("text")
      .attr("x", 52)
      .attr("y", it.y + 4)
      .attr("font-size", 11)
      .attr("fill", "#374151")
      .text(CLASS_LABEL[it.key]);
  }
}

// ----------------------
// Tooltip
// ----------------------
function ensureTooltip(svg) {
  let tip = svg.select("g._tooltip");
  if (!tip.empty()) return tip;

  tip = svg.append("g").attr("class", "_tooltip").style("display", "none");

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
    t.append("tspan").attr("x", 10).attr("dy", i === 0 ? 0 : 16).text(line);
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

// ----------------------
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

function applyBrushToMap() {
  const routesSel = viewState.routesSel;
  if (!routesSel) return;

  const range = viewState.brushRangeKm;
  if (!range) {
    // ✅ no brush → show all
    routesSel.style("display", null);
    return;
  }

  const [minKm, maxKm] = range;

  routesSel.style("display", (d) => {
    const km = d.distance_km;
    return (km >= minKm && km <= maxKm) ? null : "none";
  });
}

function updateHistogramBrushStyle() {
  const rects = viewState.histRectsSel;
  const bins = viewState.histBins;
  const range = viewState.brushRangeKm;
  if (!rects || !bins?.length) return;

  if (!range) {
    // reset
    rects.attr("opacity", 0.75).attr("fill", "#94a3b8");
    return;
  }

  const [minKm, maxKm] = range;

  rects
    .attr("opacity", (b) => {
      const inRange = (b.x1 >= minKm && b.x0 <= maxKm);
      return inRange ? 1 : 0.18;
    })
    .attr("fill", (b) => {
      const inRange = (b.x1 >= minKm && b.x0 <= maxKm);
      return inRange ? "#64748b" : "#cbd5e1";
    });
}


export const distance = { renderMap, renderSide };