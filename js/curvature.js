// js/curvature.js
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

// 且針對地圖上的點，好像會顯示地球對面的點（導致難易釋讀）
// 且當我在左側選路徑時，會顯示路線細節，我也想要在右側Curvature charts選某個點，左側會連動顯示那條路線細節 
import { initDataStore, getFilteredRoutes, capRoutes } from "./utilities.js";

// -------------------- Styling --------------------
const DEFAULT_ROUTE_COLOR = "#1f4b99";
const DEFAULT_ROUTE_OPACITY = 0.30;
const FADED_ROUTE_OPACITY = 0.10;

const CLASS_COLORS = {
  equatorial: "#f28c28",
  mid: "#7c3aed",
  polar: "#10b981",
};

const CLASS_LABEL = {
  equatorial: "equatorial-like",
  mid: "mid-latitude",
  polar: "polar-like",
};

const LAT_BINS = { equatorialMax: 30, midMax: 60 };
const MAP_ROUTE_LIMIT = 1200;

// -------------------- Basemap cache --------------------
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

// -------------------- Helpers --------------------
function safeLonLat(a) {
  if (!a) return null;
  if (!Number.isFinite(a.lon) || !Number.isFinite(a.lat)) return null;
  return [a.lon, a.lat];
}

function greatCircleLineString(src, dst, steps = 64) {
  const a = safeLonLat(src);
  const b = safeLonLat(dst);
  if (!a || !b) return null;

  const interp = d3.geoInterpolate(a, b);
  const coords = [];
  for (let i = 0; i <= steps; i++) coords.push(interp(i / steps));
  return { type: "LineString", coordinates: coords };
}

// curvature metric (lecture-friendly)
function computeCurvatureMetrics(route) {
  const line = greatCircleLineString(route.src, route.dst, 72);
  if (!line) return null;

  let maxAbsLat = 0;
  for (const c of line.coordinates) {
    const lat = c[1];
    const abs = Math.abs(lat);
    if (abs > maxAbsLat) maxAbsLat = abs;
  }

  const endMaxAbsLat = Math.max(Math.abs(route.src.lat), Math.abs(route.dst.lat));
  const curvature = Math.max(0, maxAbsLat - endMaxAbsLat);

  const cls =
    maxAbsLat <= LAT_BINS.equatorialMax ? "equatorial" :
    maxAbsLat <= LAT_BINS.midMax ? "mid" :
    "polar";

  return { line, maxAbsLat, endMaxAbsLat, curvature, cls };
}

function formatRouteTooltip(d) {
  const from = d.src?.iata || d.src?.name || "Unknown";
  const to = d.dst?.iata || d.dst?.name || "Unknown";
  const km = Math.round(d.distance_km);
  const lat = d.maxAbsLat != null ? d.maxAbsLat.toFixed(1) : "—";
  const bend = d.curvature != null ? d.curvature.toFixed(1) : "—";
  return `${from} → ${to}\n${km} km\nmax |lat| = ${lat}°\nextra bend = +${bend}° (${CLASS_LABEL[d.cls]})`;
}

// -------------------- Tooltip (SVG) --------------------
function ensureTooltip(svg) {
  let tip = svg.select("g._tooltip");
  if (!tip.empty()) return tip;

  tip = svg.append("g").attr("class", "_tooltip").style("display", "none");

  tip.append("rect")
    .attr("rx", 8)
    .attr("fill", "#111827")
    .attr("opacity", 0.92);

  tip.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "white");

  return tip;
}

function showTooltip(svg, event, text) {
  const tip = ensureTooltip(svg);
  const t = tip.select("text");
  t.selectAll("tspan").remove();

  String(text).split("\n").forEach((line, i) => {
    t.append("tspan")
      .attr("x", 10)
      .attr("dy", i === 0 ? 0 : 16)
      .text(line);
  });

  const bbox = t.node().getBBox();
  tip.select("rect")
    .attr("width", bbox.width + 20)
    .attr("height", bbox.height + 14);

  tip.style("display", null);
  moveTooltip(svg, event);
  tip.raise();
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

// Show tooltip at a fixed SVG position (useful for chart → map linking)
function showTooltipAt(svg, x, y, text) {
  const tip = ensureTooltip(svg);
  const t = tip.select("text");
  t.selectAll("tspan").remove();

  String(text).split("\n").forEach((line, i) => {
    t.append("tspan")
      .attr("x", 10)
      .attr("dy", i === 0 ? 0 : 16)
      .text(line);
  });

  const bbox = t.node().getBBox();
  tip.select("rect")
    .attr("width", bbox.width + 20)
    .attr("height", bbox.height + 14);

  tip.style("display", null);
  tip.attr("transform", `translate(${x},${y})`);
  tip.raise();
}

// -------------------- Legend --------------------
function drawCurvatureLegend(uiLayer, svgW)  {
  const boxW = 300;
  const boxH = 110;
  const topPad = 2;
  const rightPad = 6;

  // ✅ 先清掉舊 legend（避免重疊）
  uiLayer.selectAll("g.curvature-legend").remove();

  // ✅ 跟 hubs 一樣：右上角定位 + 往左推 20px
  // 但 svgW 有時會是 undefined/0（例如 caller 傳錯參數），所以這裡做防呆。
  let W = Number(svgW);
  if (!Number.isFinite(W) || W <= 0) {
    const root = uiLayer.node()?.ownerSVGElement;
    const vb = root?.getAttribute?.("viewBox");
    if (vb) {
      const parts = vb.split(/\s+/).map(Number);
      if (parts.length === 4 && Number.isFinite(parts[2])) W = parts[2];
    }
    if (!Number.isFinite(W) || W <= 0) {
      // last resort
      W = 900;
    }
  }

  const x = Math.max(0, W - boxW - rightPad - 20);
  const y = Math.max(0, topPad);


  const g = uiLayer.append("g")
    .attr("class", "curvature-legend")
    .attr("transform", `translate(${x},${y})`)
    .style("pointer-events", "none");

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
    .text("Great-circle curvature classes");

  g.append("text")
    .attr("x", 12)
    .attr("y", 38)
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text(`by max |latitude| along route: ≤${LAT_BINS.equatorialMax}°, ≤${LAT_BINS.midMax}°, >${LAT_BINS.midMax}°`);

  [
    { key: "equatorial", y: 62 },
    { key: "mid", y: 80 },
    { key: "polar", y: 98 },
  ].forEach((it) => {
    g.append("line")
      .attr("x1", 12).attr("x2", 44)
      .attr("y1", it.y).attr("y2", it.y)
      .attr("stroke", CLASS_COLORS[it.key])
      .attr("stroke-width", 3);

    g.append("text")
      .attr("x", 52)
      .attr("y", it.y + 4)
      .attr("font-size", 11)
      .attr("fill", "#374151")
      .text(CLASS_LABEL[it.key]);
  });
  g.raise();
}

// -------------------- Chart sizing --------------------
function getChartSize(svgEl, fallbackW = 360, fallbackH = 260) {
  const parent = svgEl.parentElement;
  const rect = parent ? parent.getBoundingClientRect() : null;

  let w = rect?.width ? Math.floor(rect.width) : fallbackW;
  let h = rect?.height ? Math.floor(rect.height) : fallbackH;

  // ✅ 防呆：右側容器常常高度太小（例如 140px），會讓 y 軸標籤擠在一起
  if (!Number.isFinite(w) || w < 240) w = fallbackW;
  if (!Number.isFinite(h) || h < 220) h = fallbackH;

  return { w, h };
}

// -------------------- Linked highlight --------------------
function resetHighlight(routesSel, dotsSel) {
  routesSel
    .attr("stroke", DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
    .attr("stroke-width", 1.5);

  if (dotsSel) {
    dotsSel.attr("fill-opacity", 0.65).attr("r", 3.2);
  }
}

function highlightRoute(routesSel, dotsSel, rid) {
  routesSel
    .attr("stroke", DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", FADED_ROUTE_OPACITY)
    .attr("stroke-width", 1.1);

  routesSel
    .filter((d) => d.__rid === rid)
    .raise()
    .attr("stroke", (d) => CLASS_COLORS[d.cls] || DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", 0.95)
    .attr("stroke-width", 3.2);

  if (dotsSel) {
    dotsSel.attr("fill-opacity", 0.18).attr("r", 2.4);
    dotsSel
      .filter((d) => d.__rid === rid)
      .raise()
      .attr("fill-opacity", 0.95)
      .attr("r", 5.2);
  }
}

// -------------------- Map --------------------
async function renderMap(ctx) {
  
  const { mapSvg: svg, width, height } = ctx;
  const store = await initDataStore();
  console.log("Total usable routes:", store.routesDerived.length);


  svg.selectAll("*").remove();

  // ✅ 確保拖曳事件不會被瀏覽器預設手勢吃掉
  svg.style("touch-action", "none");

  // 3D-ish globe
  const projection = d3.geoOrthographic()
    .translate([width / 2, height / 2])
    .scale(Math.min(width, height) * 0.44)
    .clipAngle(90);

  const geoPath = d3.geoPath(projection);

  // helper: hide points on the far side of the globe (improves readability)
  const isFrontSide = (airport) => {
    if (!airport || !Number.isFinite(airport.lon) || !Number.isFinite(airport.lat)) return false;
    const center = projection.invert([width / 2, height / 2]);
    if (!center) return true;
    const dist = d3.geoDistance(center, [airport.lon, airport.lat]);
    return dist <= Math.PI / 2 - 1e-6;
  };
  // ---- layers: globe content vs UI overlay ----
  const globeLayer = svg.append("g").attr("class", "curv-globe-layer");
  const uiLayer = svg.append("g").attr("class", "curv-ui-layer");


  // Basemap
  const spherePath = globeLayer.append("path")
    .datum({ type: "Sphere" })
    .attr("d", geoPath)
    .attr("fill", "#f7fbff")
    .attr("stroke", "#d1d5db")
    .attr("stroke-width", 1);

  const { land, borders } = await loadWorldLayers();

  const landPath = globeLayer.append("path")
    .datum(land)
    .attr("d", geoPath)
    .attr("fill", "#dde5ee")
    .attr("stroke", "none")
    .attr("opacity", 1);

  const borderPath = globeLayer.append("path")
    .datum(borders)
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", "#c7d0dc")
    .attr("stroke-width", 0.7)
    .attr("opacity", 0.95);

  const graticule = d3.geoGraticule().step([30, 30]);
  const gratPath = globeLayer.append("path")
    .datum(graticule())
    .attr("d", geoPath)
    .attr("fill", "none")
    .attr("stroke", "#e5e7eb")
    .attr("stroke-width", 0.7)
    .attr("opacity", 0.6);

  // ✅ legend 要用 map 的 panel 寬度，才能穩定定位右上角
  drawCurvatureLegend(uiLayer, width);


  // Data
  const routesAll = getFilteredRoutes(store, store.state.filters);
  const routesCapped = capRoutes(routesAll, MAP_ROUTE_LIMIT, "longFirst");

  const routes = [];
  for (let i = 0; i < routesCapped.length; i++) {
    const r = routesCapped[i];
    const m = computeCurvatureMetrics(r);
    if (!m) continue;
    routes.push({
      ...r,
      ...m,
      __rid: `${r.src?.iata || "src"}-${r.dst?.iata || "dst"}-${i}`,
    });
  }

  // Layers
  const routesG = globeLayer.append("g").attr("class", "curvature-routes");
  const nodesG = globeLayer.append("g").attr("class", "curvature-nodes");

  const routesSel = routesG.selectAll("path.route")
    .data(routes, (d) => d.__rid)
    .join("path")
    .attr("class", (d) => `route route-${d.cls}`)
    .attr("fill", "none")
    .attr("stroke", DEFAULT_ROUTE_COLOR)
    .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
    .attr("stroke-width", 1.5)
    .attr("d", (d) => geoPath(d.line))
    .on("mouseenter", function (event, d) {
      highlightRoute(routesSel, null, d.__rid);
      showTooltip(svg, event, formatRouteTooltip(d));
    })
    .on("mousemove", function (event) {
      moveTooltip(svg, event);
    })
    .on("mouseleave", function () {
      resetHighlight(routesSel, null);
      hideTooltip(svg);
    });

  // A few endpoints (optional anchors)
  //const endpoints = routes.slice(0, 80).flatMap((r) => [r.src, r.dst]);
  const endpoints = routes.flatMap((r) => [r.src, r.dst]);

  const unique = dedupeAirports(endpoints);

  const nodesSel = nodesG.selectAll("circle.airport")
    .data(unique, (d) => d.iata || d.name)
    .join("circle")
    .attr("class", "airport")
    .attr("r", 2.2)
    .attr("fill", "#111827")
    .attr("opacity", 0.65)
    .attr("transform", (d) => {
      const p = projection([d.lon, d.lat]);
      return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
    })
    .style("display", (d) => (isFrontFacing(d) ? null : "none"));

  // ✅ hide points on the far side of the globe (easier to read)
  function isFrontFacing(airport) {
    const p = safeLonLat(airport);
    if (!p) return false;
    const center = projection.invert([width / 2, height / 2]);
    if (!center) return false;
    return d3.geoDistance(center, p) <= Math.PI / 2 - 1e-6;
  }

  // ✅ 用 DOM node 存共享資料（不再用 selection.property）
  const node = svg.node();
  node.__curv_routes__ = routes;
  node.__curv_routesSel__ = routesSel;
  node.__curv_geoPath__ = geoPath;
  node.__curv_projection__ = projection;

  function redraw() {
    spherePath.attr("d", geoPath);
    landPath.attr("d", geoPath);
    borderPath.attr("d", geoPath);
    gratPath.attr("d", geoPath);

    routesSel.attr("d", (d) => geoPath(d.line));

    nodesSel
      .attr("transform", (d) => {
        const p = projection([d.lon, d.lat]);
        return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
      })
      .style("display", (d) => (isFrontFacing(d) ? null : "none"));

    // tooltip keep on top
    const tip = svg.select("g._tooltip");
    if (!tip.empty() && tip.style("display") !== "none") tip.raise();
  }

  // Drag rotate
  const drag = d3.drag()
    .on("start", (event) => {
      node.__drag_start__ = {
        x: event.x,
        y: event.y,
        rot: projection.rotate(),
      };
    })
    .on("drag", (event) => {
      const s = node.__drag_start__;
      if (!s) return;

      const dx = event.x - s.x;
      const dy = event.y - s.y;

      const rot = s.rot.slice();
      const k = 0.25;
      rot[0] = rot[0] + dx * k;
      rot[1] = rot[1] - dy * k;
      rot[1] = Math.max(-80, Math.min(80, rot[1]));
      projection.rotate(rot);

      redraw();
    });

  svg.call(drag);
}

// -------------------- Side: scatter --------------------
async function renderSide(ctx) {
  
  const root = ctx.sideRoot;
  const svgEl = root?.querySelector("#curvature-chart-1");
  if (!svgEl) return;

  // ✅ CSS 的 .chart-slot 預設 height:140px，會把 SVG 視覺壓扁，造成 y 軸標籤擠在一起。
  // 這裡只針對 Curvature 這張圖，把 slot 撐高。
  const slot = svgEl.closest?.(".chart-slot");
  if (slot) {
    slot.style.height = "220px";
    slot.style.alignItems = "stretch";
  }

  const mapNode = ctx.mapSvg.node();
  const routes = mapNode?.__curv_routes__ || [];
  const routesSel = mapNode?.__curv_routesSel__;

  d3.select(svgEl).selectAll("*").remove();
  renderScatter(svgEl, routes, ctx.mapSvg, routesSel);
}

function renderScatter(svgEl, routes, mapSvg, routesSel) {
  const { w, h } = getChartSize(svgEl, 360, 260);
  // ✅ 左邊留更多空間給 y 軸標籤，避免擠壓
  const margin = { top: 44, right: 14, bottom: 62, left: 66 };
  const innerW = w - margin.left - margin.right;
  const innerH = h - margin.top - margin.bottom;

  const svg = d3.select(svgEl)
    .attr("width", w)          // ✅ 改成固定像素，避免 100% + parent=0 高度看不到
    .attr("height", h)
    .attr("viewBox", `0 0 ${w} ${h}`);

  svg.append("text")
    .attr("x", 10)
    .attr("y", 18)
    .attr("font-size", 12)
    .attr("fill", "#374151")
    .attr("font-weight", 600)
    .text("Great-circle latitude vs distance");

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const xs = routes.map((d) => d.maxAbsLat).filter((v) => Number.isFinite(v));
  const ys = routes.map((d) => d.distance_km).filter((v) => Number.isFinite(v));

  const x = d3.scaleLinear()
    .domain([0, Math.max(80, d3.max(xs) || 80)])
    .nice()
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, d3.max(ys) || 12000])
    .nice()
    .range([innerH, 0]);

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat((d) => `${d}°`))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  g.append("g")
    // ✅ ticks 少一點 + 字體小一點 + padding 大一點，避免重疊
    .call(
      d3.axisLeft(y)
        .ticks(4)
        .tickSizeOuter(0)
        .tickPadding(8)
        .tickFormat((d) => `${Math.round(d / 1000)}k`)
    )
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280").attr("font-size", 10))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  g.append("text")
    .attr("x", innerW)
    .attr("y", innerH + 36)
    .attr("text-anchor", "end")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("max |latitude| along route");

  g.append("text")
    .attr("x", 0)
    .attr("y", -10)
    .attr("text-anchor", "start")
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text("distance (km)");

  const dots = g.append("g")
    .selectAll("circle.dot")
    .data(routes, (d) => d.__rid)
    .join("circle")
    .attr("class", (d) => `dot dot-${d.cls}`)
    .attr("cx", (d) => x(d.maxAbsLat))
    .attr("cy", (d) => y(d.distance_km))
    .attr("r", 3.2)
    .attr("fill", (d) => CLASS_COLORS[d.cls] || "#64748b")
    .attr("fill-opacity", 0.65)
    .on("mouseenter", function (event, d) {
      if (!routesSel) return;
      highlightRoute(routesSel, dots, d.__rid);
      // ✅ also show the same route detail on the map
      if (mapSvg) showTooltipAt(mapSvg, 16, 16, formatRouteTooltip(d));
    })
    .on("mouseleave", function () {
      if (!routesSel) return;
      resetHighlight(routesSel, dots);
      if (mapSvg) hideTooltip(mapSvg);
    });

  svg.append("text")
    .attr("x", 10)
    .attr("y", h - 10)
    .attr("font-size", 10.5)
    .attr("fill", "#94a3b8")
    .text("Tip: drag the globe to rotate. Hover a dot to highlight its route.");
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

export const curvature = { renderMap, renderSide };


// // js/curvature.js
// import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
// import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

// // 且針對地圖上的點，好像會顯示地球對面的點（導致難易釋讀）
// // 且當我在左側選路徑時，會顯示路線細節，我也想要在右側Curvature charts選某個點，左側會連動顯示那條路線細節 
// import { initDataStore, getFilteredRoutes, capRoutes } from "./utilities.js";

// // -------------------- Styling --------------------
// const DEFAULT_ROUTE_COLOR = "#1f4b99";
// const DEFAULT_ROUTE_OPACITY = 0.30;
// const FADED_ROUTE_OPACITY = 0.10;

// const CLASS_COLORS = {
//   equatorial: "#f28c28",
//   mid: "#7c3aed",
//   polar: "#10b981",
// };

// const CLASS_LABEL = {
//   equatorial: "equatorial-like",
//   mid: "mid-latitude",
//   polar: "polar-like",
// };

// const LAT_BINS = { equatorialMax: 30, midMax: 60 };
// const MAP_ROUTE_LIMIT = 1200;

// // -------------------- Basemap cache --------------------
// const WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
// let _worldTopo = null;
// let _land = null;
// let _borders = null;

// async function loadWorldLayers() {
//   if (_land && _borders) return { land: _land, borders: _borders };
//   if (!_worldTopo) _worldTopo = await d3.json(WORLD_ATLAS_URL);

//   const countries = _worldTopo.objects.countries;
//   _land = topojson.feature(_worldTopo, countries);
//   _borders = topojson.mesh(_worldTopo, countries, (a, b) => a !== b);

//   return { land: _land, borders: _borders };
// }

// // -------------------- Helpers --------------------
// function safeLonLat(a) {
//   if (!a) return null;
//   if (!Number.isFinite(a.lon) || !Number.isFinite(a.lat)) return null;
//   return [a.lon, a.lat];
// }

// function greatCircleLineString(src, dst, steps = 64) {
//   const a = safeLonLat(src);
//   const b = safeLonLat(dst);
//   if (!a || !b) return null;

//   const interp = d3.geoInterpolate(a, b);
//   const coords = [];
//   for (let i = 0; i <= steps; i++) coords.push(interp(i / steps));
//   return { type: "LineString", coordinates: coords };
// }

// // curvature metric (lecture-friendly)
// function computeCurvatureMetrics(route) {
//   const line = greatCircleLineString(route.src, route.dst, 72);
//   if (!line) return null;

//   let maxAbsLat = 0;
//   for (const c of line.coordinates) {
//     const lat = c[1];
//     const abs = Math.abs(lat);
//     if (abs > maxAbsLat) maxAbsLat = abs;
//   }

//   const endMaxAbsLat = Math.max(Math.abs(route.src.lat), Math.abs(route.dst.lat));
//   const curvature = Math.max(0, maxAbsLat - endMaxAbsLat);

//   const cls =
//     maxAbsLat <= LAT_BINS.equatorialMax ? "equatorial" :
//     maxAbsLat <= LAT_BINS.midMax ? "mid" :
//     "polar";

//   return { line, maxAbsLat, endMaxAbsLat, curvature, cls };
// }

// function formatRouteTooltip(d) {
//   const from = d.src?.iata || d.src?.name || "Unknown";
//   const to = d.dst?.iata || d.dst?.name || "Unknown";
//   const km = Math.round(d.distance_km);
//   const lat = d.maxAbsLat != null ? d.maxAbsLat.toFixed(1) : "—";
//   const bend = d.curvature != null ? d.curvature.toFixed(1) : "—";
//   return `${from} → ${to}\n${km} km\nmax |lat| = ${lat}°\nextra bend = +${bend}° (${CLASS_LABEL[d.cls]})`;
// }

// // -------------------- Tooltip (SVG) --------------------
// function ensureTooltip(svg) {
//   let tip = svg.select("g._tooltip");
//   if (!tip.empty()) return tip;

//   tip = svg.append("g").attr("class", "_tooltip").style("display", "none");

//   tip.append("rect")
//     .attr("rx", 8)
//     .attr("fill", "#111827")
//     .attr("opacity", 0.92);

//   tip.append("text")
//     .attr("x", 10)
//     .attr("y", 18)
//     .attr("font-size", 12)
//     .attr("fill", "white");

//   return tip;
// }

// function showTooltip(svg, event, text) {
//   const tip = ensureTooltip(svg);
//   const t = tip.select("text");
//   t.selectAll("tspan").remove();

//   String(text).split("\n").forEach((line, i) => {
//     t.append("tspan")
//       .attr("x", 10)
//       .attr("dy", i === 0 ? 0 : 16)
//       .text(line);
//   });

//   const bbox = t.node().getBBox();
//   tip.select("rect")
//     .attr("width", bbox.width + 20)
//     .attr("height", bbox.height + 14);

//   tip.style("display", null);
//   moveTooltip(svg, event);
//   tip.raise();
// }

// function moveTooltip(svg, event) {
//   const tip = svg.select("g._tooltip");
//   if (tip.empty()) return;
//   const [mx, my] = d3.pointer(event, svg.node());
//   tip.attr("transform", `translate(${mx + 12},${my + 12})`);
// }

// function hideTooltip(svg) {
//   svg.select("g._tooltip").style("display", "none");
// }

// // -------------------- Legend --------------------
// function drawCurvatureLegend(uiLayer, svgW)  {
//   const boxW = 300;
//   const boxH = 110;
//   const topPad = 2;
//   const rightPad = 6;

//   // ✅ 先清掉舊 legend（避免重疊）
//   uiLayer.selectAll("g.curvature-legend").remove();

//   // ✅ 跟 hubs 一樣：右上角定位 + 往左推 20px
//   const x = Math.max(0, svgW - boxW - rightPad - 20);
//   const y = Math.max(0, topPad);


//   const g = uiLayer.append("g")
//     .attr("class", "curvature-legend")
//     .attr("transform", `translate(${x},${y})`);

//   g.append("rect")
//     .attr("width", boxW)
//     .attr("height", boxH)
//     .attr("rx", 10)
//     .attr("fill", "white")
//     .attr("opacity", 0.92)
//     .attr("stroke", "#e5e7eb");

//   g.append("text")
//     .attr("x", 12)
//     .attr("y", 20)
//     .attr("font-size", 12)
//     .attr("fill", "#111827")
//     .attr("font-weight", 600)
//     .text("Great-circle curvature classes");

//   g.append("text")
//     .attr("x", 12)
//     .attr("y", 38)
//     .attr("font-size", 11)
//     .attr("fill", "#6b7280")
//     .text(`by max |latitude| along route: ≤${LAT_BINS.equatorialMax}°, ≤${LAT_BINS.midMax}°, >${LAT_BINS.midMax}°`);

//   [
//     { key: "equatorial", y: 62 },
//     { key: "mid", y: 80 },
//     { key: "polar", y: 98 },
//   ].forEach((it) => {
//     g.append("line")
//       .attr("x1", 12).attr("x2", 44)
//       .attr("y1", it.y).attr("y2", it.y)
//       .attr("stroke", CLASS_COLORS[it.key])
//       .attr("stroke-width", 3);

//     g.append("text")
//       .attr("x", 52)
//       .attr("y", it.y + 4)
//       .attr("font-size", 11)
//       .attr("fill", "#374151")
//       .text(CLASS_LABEL[it.key]);
//   });
//   g.raise();
// }

// // -------------------- Chart sizing --------------------
// function getChartSize(svgEl, fallbackW = 360, fallbackH = 260) {
//   const parent = svgEl.parentElement;
//   const rect = parent ? parent.getBoundingClientRect() : null;

//   let w = rect?.width ? Math.floor(rect.width) : fallbackW;
//   let h = rect?.height ? Math.floor(rect.height) : fallbackH;

//   // ✅ 防呆：很多 UI 右側 svg container 高度會是 0
//   if (!Number.isFinite(w) || w < 240) w = fallbackW;
//   if (!Number.isFinite(h) || h < 120) h = fallbackH;

//   return { w, h };
// }

// // -------------------- Linked highlight --------------------
// function resetHighlight(routesSel, dotsSel) {
//   routesSel
//     .attr("stroke", DEFAULT_ROUTE_COLOR)
//     .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
//     .attr("stroke-width", 1.5);

//   if (dotsSel) {
//     dotsSel.attr("fill-opacity", 0.65).attr("r", 3.2);
//   }
// }

// function highlightRoute(routesSel, dotsSel, rid) {
//   routesSel
//     .attr("stroke", DEFAULT_ROUTE_COLOR)
//     .attr("stroke-opacity", FADED_ROUTE_OPACITY)
//     .attr("stroke-width", 1.1);

//   routesSel
//     .filter((d) => d.__rid === rid)
//     .raise()
//     .attr("stroke", (d) => CLASS_COLORS[d.cls] || DEFAULT_ROUTE_COLOR)
//     .attr("stroke-opacity", 0.95)
//     .attr("stroke-width", 3.2);

//   if (dotsSel) {
//     dotsSel.attr("fill-opacity", 0.18).attr("r", 2.4);
//     dotsSel
//       .filter((d) => d.__rid === rid)
//       .raise()
//       .attr("fill-opacity", 0.95)
//       .attr("r", 5.2);
//   }
// }

// // -------------------- Map --------------------
// async function renderMap(ctx) {
  
//   const { mapSvg: svg, width, height } = ctx;
//   const store = await initDataStore();
//   console.log("Total usable routes:", store.routesDerived.length);


//   svg.selectAll("*").remove();

//   // ✅ 確保拖曳事件不會被瀏覽器預設手勢吃掉
//   svg.style("touch-action", "none");

//   // 3D-ish globe
//   const projection = d3.geoOrthographic()
//     .translate([width / 2, height / 2])
//     .scale(Math.min(width, height) * 0.44)
//     .clipAngle(90);

//   const geoPath = d3.geoPath(projection);
//   // ---- layers: globe content vs UI overlay ----
//   const globeLayer = svg.append("g").attr("class", "curv-globe-layer");
//   const uiLayer = svg.append("g").attr("class", "curv-ui-layer");


//   // Basemap
//   const spherePath = globeLayer.append("path")
//     .datum({ type: "Sphere" })
//     .attr("d", geoPath)
//     .attr("fill", "#f7fbff")
//     .attr("stroke", "#d1d5db")
//     .attr("stroke-width", 1);

//   const { land, borders } = await loadWorldLayers();

//   const landPath = globeLayer.append("path")
//     .datum(land)
//     .attr("d", geoPath)
//     .attr("fill", "#dde5ee")
//     .attr("stroke", "none")
//     .attr("opacity", 1);

//   const borderPath = globeLayer.append("path")
//     .datum(borders)
//     .attr("d", geoPath)
//     .attr("fill", "none")
//     .attr("stroke", "#c7d0dc")
//     .attr("stroke-width", 0.7)
//     .attr("opacity", 0.95);

//   const graticule = d3.geoGraticule().step([30, 30]);
//   const gratPath = globeLayer.append("path")
//     .datum(graticule())
//     .attr("d", geoPath)
//     .attr("fill", "none")
//     .attr("stroke", "#e5e7eb")
//     .attr("stroke-width", 0.7)
//     .attr("opacity", 0.6);

//   drawCurvatureLegend(uiLayer, width);


//   // Data
//   const routesAll = getFilteredRoutes(store, store.state.filters);
//   const routesCapped = capRoutes(routesAll, MAP_ROUTE_LIMIT, "longFirst");

//   const routes = [];
//   for (let i = 0; i < routesCapped.length; i++) {
//     const r = routesCapped[i];
//     const m = computeCurvatureMetrics(r);
//     if (!m) continue;
//     routes.push({
//       ...r,
//       ...m,
//       __rid: `${r.src?.iata || "src"}-${r.dst?.iata || "dst"}-${i}`,
//     });
//   }

//   // Layers
//   const routesG = globeLayer.append("g").attr("class", "curvature-routes");
//   const nodesG = globeLayer.append("g").attr("class", "curvature-nodes");

//   const routesSel = routesG.selectAll("path.route")
//     .data(routes, (d) => d.__rid)
//     .join("path")
//     .attr("class", (d) => `route route-${d.cls}`)
//     .attr("fill", "none")
//     .attr("stroke", DEFAULT_ROUTE_COLOR)
//     .attr("stroke-opacity", DEFAULT_ROUTE_OPACITY)
//     .attr("stroke-width", 1.5)
//     .attr("d", (d) => geoPath(d.line))
//     .on("mouseenter", function (event, d) {
//       highlightRoute(routesSel, null, d.__rid);
//       showTooltip(svg, event, formatRouteTooltip(d));
//     })
//     .on("mousemove", function (event) {
//       moveTooltip(svg, event);
//     })
//     .on("mouseleave", function () {
//       resetHighlight(routesSel, null);
//       hideTooltip(svg);
//     });

//   // A few endpoints (optional anchors)
//   const endpoints = routes.slice(0, 80).flatMap((r) => [r.src, r.dst]);
//   const unique = dedupeAirports(endpoints);

//   nodesG.selectAll("circle.airport")
//     .data(unique, (d) => d.iata || d.name)
//     .join("circle")
//     .attr("class", "airport")
//     .attr("r", 2.2)
//     .attr("fill", "#111827")
//     .attr("opacity", 0.65)
//     .attr("transform", (d) => {
//       const p = projection([d.lon, d.lat]);
//       return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
//     });

//   // ✅ 用 DOM node 存共享資料（不再用 selection.property）
//   const node = svg.node();
//   node.__curv_routes__ = routes;
//   node.__curv_routesSel__ = routesSel;
//   node.__curv_geoPath__ = geoPath;
//   node.__curv_projection__ = projection;

//   function redraw() {
//     spherePath.attr("d", geoPath);
//     landPath.attr("d", geoPath);
//     borderPath.attr("d", geoPath);
//     gratPath.attr("d", geoPath);

//     routesSel.attr("d", (d) => geoPath(d.line));

//     nodesG.selectAll("circle.airport")
//       .attr("transform", (d) => {
//         const p = projection([d.lon, d.lat]);
//         return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
//       });

//     // tooltip keep on top
//     const tip = svg.select("g._tooltip");
//     if (!tip.empty() && tip.style("display") !== "none") tip.raise();
//   }

//   // Drag rotate
//   const drag = d3.drag()
//     .on("start", (event) => {
//       node.__drag_start__ = {
//         x: event.x,
//         y: event.y,
//         rot: projection.rotate(),
//       };
//     })
//     .on("drag", (event) => {
//       const s = node.__drag_start__;
//       if (!s) return;

//       const dx = event.x - s.x;
//       const dy = event.y - s.y;

//       const rot = s.rot.slice();
//       const k = 0.25;
//       rot[0] = rot[0] + dx * k;
//       rot[1] = rot[1] - dy * k;
//       rot[1] = Math.max(-80, Math.min(80, rot[1]));
//       projection.rotate(rot);

//       redraw();
//     });

//   svg.call(drag);
// }

// // -------------------- Side: scatter --------------------
// async function renderSide(ctx) {
  
//   const root = ctx.sideRoot;
//   const svgEl = root?.querySelector("#curvature-chart-1");
//   if (!svgEl) return;

//   const mapNode = ctx.mapSvg.node();
//   const routes = mapNode?.__curv_routes__ || [];
//   const routesSel = mapNode?.__curv_routesSel__;

//   d3.select(svgEl).selectAll("*").remove();
//   renderScatter(svgEl, routes, ctx.mapSvg, routesSel);
// }

// function renderScatter(svgEl, routes, mapSvg, routesSel) {
//   const { w, h } = getChartSize(svgEl, 360, 260);
//   const margin = { top: 44, right: 14, bottom: 58, left: 50 };
//   const innerW = w - margin.left - margin.right;
//   const innerH = h - margin.top - margin.bottom;

//   const svg = d3.select(svgEl)
//     .attr("width", w)          // ✅ 改成固定像素，避免 100% + parent=0 高度看不到
//     .attr("height", h)
//     .attr("viewBox", `0 0 ${w} ${h}`);

//   svg.append("text")
//     .attr("x", 10)
//     .attr("y", 18)
//     .attr("font-size", 12)
//     .attr("fill", "#374151")
//     .attr("font-weight", 600)
//     .text("Great-circle latitude vs distance");

//   const g = svg.append("g")
//     .attr("transform", `translate(${margin.left},${margin.top})`);

//   const xs = routes.map((d) => d.maxAbsLat).filter((v) => Number.isFinite(v));
//   const ys = routes.map((d) => d.distance_km).filter((v) => Number.isFinite(v));

//   const x = d3.scaleLinear()
//     .domain([0, Math.max(80, d3.max(xs) || 80)])
//     .nice()
//     .range([0, innerW]);

//   const y = d3.scaleLinear()
//     .domain([0, d3.max(ys) || 12000])
//     .nice()
//     .range([innerH, 0]);

//   g.append("g")
//     .attr("transform", `translate(0,${innerH})`)
//     .call(d3.axisBottom(x).ticks(5).tickFormat((d) => `${d}°`))
//     .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
//     .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

//   g.append("g")
//     .call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${Math.round(d / 1000)}k`))
//     .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
//     .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

//   g.append("text")
//     .attr("x", innerW)
//     .attr("y", innerH + 36)
//     .attr("text-anchor", "end")
//     .attr("font-size", 11)
//     .attr("fill", "#6b7280")
//     .text("max |latitude| along route");

//   g.append("text")
//     .attr("x", 0)
//     .attr("y", -10)
//     .attr("text-anchor", "start")
//     .attr("font-size", 11)
//     .attr("fill", "#6b7280")
//     .text("distance (km)");

//   const dots = g.append("g")
//     .selectAll("circle.dot")
//     .data(routes, (d) => d.__rid)
//     .join("circle")
//     .attr("class", (d) => `dot dot-${d.cls}`)
//     .attr("cx", (d) => x(d.maxAbsLat))
//     .attr("cy", (d) => y(d.distance_km))
//     .attr("r", 3.2)
//     .attr("fill", (d) => CLASS_COLORS[d.cls] || "#64748b")
//     .attr("fill-opacity", 0.65)
//     .on("mouseenter", function (_, d) {
//       if (!routesSel) return;
//       highlightRoute(routesSel, dots, d.__rid);
//     })
//     .on("mouseleave", function () {
//       if (!routesSel) return;
//       resetHighlight(routesSel, dots);
//     });

//   svg.append("text")
//     .attr("x", 10)
//     .attr("y", h - 10)
//     .attr("font-size", 10.5)
//     .attr("fill", "#94a3b8")
//     .text("Tip: drag the globe to rotate. Hover a dot to highlight its route.");
// }

// function dedupeAirports(list) {
//   const seen = new Set();
//   const out = [];
//   for (const a of list) {
//     const key = a?.iata || a?.name;
//     if (!key || seen.has(key)) continue;
//     seen.add(key);
//     out.push(a);
//   }
//   return out;
// }

// export const curvature = { renderMap, renderSide };
