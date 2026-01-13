import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

import {
  initDataStore,
  computeOutDegree,
  capRoutes, // ✅ utilities.js 有的話就用（沒有也沒關係，我下面有 fallback）
} from "./utilities.js";

/**
 * Hubs view (Sophie)
 * Updates:
 * 1) Legend numbers explained + clearer (not mistaken as "only these hubs")
 * 2) Show route paths on the globe (all routes, but capped for performance)
 * 3) Fix right bar labels being squished (auto margin + truncate + tooltip)
 */

const WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
let _worldTopo = null;
let _land = null;
let _borders = null;

const LAND_FILL = "#dde5ee";
const BORDER_STROKE = "#c7d0dc";
const SPHERE_FILL = "#f7fbff";
const GRID_STROKE = "#e5e7eb";

// Map styling
const ROUTE_COLOR = "#1f4b99"; // neutral deep-blue
const ROUTE_OPACITY = 0.15;
const ROUTE_WIDTH = 1.0;

const HUB_FILL = "#1f4b99";
const HUB_HIGHLIGHT = "#f28c28";
const HUB_FADE_OPACITY = 0.12;
const HUB_DEFAULT_OPACITY = 0.8;

const MAX_ROUTES_ON_MAP = 5000; // ✅ show “all routes” but cap to keep smooth
const TOP_HUBS_FOR_BAR = 12;
const HUBS_FOR_MAP = 200; // ✅ show more hubs on map (not just top 60)

const viewState = {
  hubsTop: [],
  hubPointsSel: null,
  barSel: null,
  tooltipSel: null,
};

async function loadWorldLayers() {
  if (_land && _borders) return { land: _land, borders: _borders };
  if (!_worldTopo) _worldTopo = await d3.json(WORLD_ATLAS_URL);

  const countries = _worldTopo.objects.countries;
  _land = topojson.feature(_worldTopo, countries);
  _borders = topojson.mesh(_worldTopo, countries, (a, b) => a !== b);

  return { land: _land, borders: _borders };
}

// ---------- geometry helpers ----------
function greatCircleLineString(src, dst, steps = 30) {
  const a = [src.lon, src.lat];
  const b = [dst.lon, dst.lat];
  const interp = d3.geoInterpolate(a, b);

  const coords = [];
  for (let i = 0; i <= steps; i++) coords.push(interp(i / steps));
  return { type: "LineString", coordinates: coords };
}

// ---------- render map ----------
async function renderMap(ctx) {
  const { mapSvg: svg, width, height } = ctx;
  const store = await initDataStore();

  svg.selectAll("*").remove();

  const projection = d3.geoNaturalEarth1();
  projection.fitSize([width, height], { type: "Sphere" });
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

  // ---------------------------
  // 1) Draw routes (paths)
  // ---------------------------
  // const routesAll = store.routesDerived || [];
  // const routes = safeCapRoutes(routesAll, MAX_ROUTES_ON_MAP);

  // const routesG = svg.append("g").attr("class", "hub-routes");

  // routesG.selectAll("path.route")
  //   .data(routes, (d, i) => `${d.src?.iata || "src"}-${d.dst?.iata || "dst"}-${i}`)
  //   .join("path")
  //   .attr("class", "route")
  //   .attr("fill", "none")
  //   .attr("stroke", ROUTE_COLOR)
  //   .attr("stroke-opacity", ROUTE_OPACITY)
  //   .attr("stroke-width", ROUTE_WIDTH)
  //   .attr("d", (d) => geoPath(greatCircleLineString(d.src, d.dst, 30)));
   // 供 tooltip clamp 用：sphere 真正的可視範圍（不是整個 svg）
  svg.property("__sphereBounds__", geoPath.bounds({ type: "Sphere" }));

  // ---------------------------
  // 2) Compute hubs (departures)
  // ---------------------------
  const hubsAll = computeOutDegree(store, store.routesDerived)
    .filter((d) => d.airport && isFinite(d.airport.lat) && isFinite(d.airport.lon));

  viewState.hubsTop = hubsAll.slice(0, TOP_HUBS_FOR_BAR);

  // show more hubs on map (not too many to avoid clutter)
  const hubsForMap = hubsAll.slice(0, HUBS_FOR_MAP);

  const maxCount = d3.max(hubsForMap, (d) => d.count) || 1;
  const r = d3.scaleSqrt().domain([0, maxCount]).range([2, 16]);

  ensureMapTooltip(svg);

  const hubsG = svg.append("g").attr("class", "hub-points");

  const points = hubsG.selectAll("circle.hub")
    .data(hubsForMap, (d) => d.iata)
    .join("circle")
    .attr("class", "hub")
    .attr("r", (d) => r(d.count))
    .attr("fill", HUB_FILL)
    .attr("fill-opacity", HUB_DEFAULT_OPACITY)
    .attr("stroke", "white")
    .attr("stroke-width", 0.9)
    .attr("transform", (d) => {
      const p = projection([d.airport.lon, d.airport.lat]);
      return p ? `translate(${p[0]},${p[1]})` : "translate(-999,-999)";
    })
    .on("mouseenter", function (event, d) {
      highlightHub(d.iata);
      showMapTooltip(svg, event, formatHubTooltip(d));
    })
    .on("mousemove", function (event) {
      moveMapTooltip(svg, event);
    })
    .on("mouseleave", function () {
      clearHighlight();
      hideMapTooltip(svg);
    });

  viewState.hubPointsSel = points;

  // Legend: clearer text so you don't think 229/549/915 are "only those hubs"
  drawHubLegend(svg, geoPath, maxCount, r);
}

// ---------- render side ----------
async function renderSide(ctx) {
  const root = ctx.sideRoot;
  const svgEl = root?.querySelector("#hubs-chart-1");
  if (!svgEl) return;

  d3.select(svgEl).selectAll("*").remove();

  const data = viewState.hubsTop || [];
  renderHubsBarChart(svgEl, data);
}

// ---------- bar chart ----------
function getChartSize(svgEl, fallbackW = 420, fallbackH = 320) {
  const parent = svgEl.parentElement;
  const rect = parent ? parent.getBoundingClientRect() : null;
  const w = rect?.width ? Math.floor(rect.width) : fallbackW;
  const h = rect?.height ? Math.floor(rect.height) : fallbackH;
  return { w, h };
}

function truncateLabel(s, maxLen = 18) {
  const str = String(s ?? "");
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}

function renderHubsBarChart(svgEl, hubs) {
  const { w, h } = getChartSize(svgEl, 460, 330);

  // ✅ build labels first
  const labels = hubs.map((d) => {
    const city = d?.airport?.city ? ` (${d.airport.city})` : "";
    return `${d.iata}${city}`;
  });

  // ✅ auto margin-left based on label length (rough estimate)
  const approxMaxChars = d3.max(labels, (s) => s.length) || 10;
  const autoLeft = Math.min(240, Math.max(140, Math.round(approxMaxChars * 6.5)));

  const margin = { top: 28, right: 18, bottom: 28, left: autoLeft };
  const innerW = w - margin.left - margin.right;
  const innerH = h - margin.top - margin.bottom;

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
    .text("Top departing hubs");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const y = d3.scaleBand()
    .domain(hubs.map((d) => d.iata))
    .range([0, innerH])
    .padding(0.25);

  const x = d3.scaleLinear()
    .domain([0, d3.max(hubs, (d) => d.count) || 1])
    .nice()
    .range([0, innerW]);

  // y axis with truncation + title tooltip
  const yAxis = d3.axisLeft(y).tickFormat((iata) => {
    const d = hubs.find((x) => x.iata === iata);
    const city = d?.airport?.city ? ` (${d.airport.city})` : "";
    return truncateLabel(`${iata}${city}`, 22);
  });

  const yAxisG = g.append("g").call(yAxis);

  yAxisG.selectAll("text")
    .attr("fill", "#374151")
    .attr("font-size", 11);

  // ✅ add title on each tick so hover shows full label
  yAxisG.selectAll(".tick")
    .append("title")
    .text((iata) => {
      const d = hubs.find((x) => x.iata === iata);
      const city = d?.airport?.city ? ` (${d.airport.city})` : "";
      const country = d?.airport?.country ? `, ${d.airport.country}` : "";
      return `${iata}${city}${country}`;
    });

  yAxisG.selectAll("path,line").attr("stroke", "#e5e7eb");

  // x axis
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(4))
    .call((sel) => sel.selectAll("text").attr("fill", "#6b7280"))
    .call((sel) => sel.selectAll("path,line").attr("stroke", "#e5e7eb"));

  const bars = g.selectAll("rect.bar")
    .data(hubs, (d) => d.iata)
    .join("rect")
    .attr("class", "bar")
    .attr("x", 0)
    .attr("y", (d) => y(d.iata))
    .attr("height", y.bandwidth())
    .attr("width", (d) => x(d.count))
    .attr("fill", HUB_FILL)
    .attr("opacity", 0.75)
    .on("mouseenter", function (event, d) {
      highlightHub(d.iata);
    })
    .on("mouseleave", function () {
      clearHighlight();
    });

  // value labels
  g.selectAll("text.value")
    .data(hubs, (d) => d.iata)
    .join("text")
    .attr("class", "value")
    .attr("x", (d) => x(d.count) + 6)
    .attr("y", (d) => (y(d.iata) ?? 0) + y.bandwidth() / 2 + 4)
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text((d) => d.count.toLocaleString());

  viewState.barSel = bars;
}

// ---------- highlight sync ----------
function highlightHub(iata) {
  if (viewState.hubPointsSel) {
    viewState.hubPointsSel
      .attr("fill", HUB_FILL)
      .attr("fill-opacity", HUB_FADE_OPACITY);

    viewState.hubPointsSel
      .filter((d) => d.iata === iata)
      .attr("fill", HUB_HIGHLIGHT)
      .attr("fill-opacity", 1)
      .raise();
  }

  if (viewState.barSel) {
    viewState.barSel
      .attr("fill", HUB_FILL)
      .attr("opacity", 0.18);

    viewState.barSel
      .filter((d) => d.iata === iata)
      .attr("fill", HUB_HIGHLIGHT)
      .attr("opacity", 0.95);
  }
}

function clearHighlight() {
  if (viewState.hubPointsSel) {
    viewState.hubPointsSel
      .attr("fill", HUB_FILL)
      .attr("fill-opacity", HUB_DEFAULT_OPACITY);
  }
  if (viewState.barSel) {
    viewState.barSel
      .attr("fill", HUB_FILL)
      .attr("opacity", 0.75);
  }
}

// ---------- tooltip ----------
function ensureMapTooltip(svg) {
  let tip = svg.select("g._hubTooltip");
  if (!tip.empty()) return tip;

  tip = svg.append("g")
    .attr("class", "_hubTooltip")
    .style("display", "none")
    .style("pointer-events", "none"); // ✅ 不要擋到 hover

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


function showMapTooltip(svg, event, text) {
  const tip = ensureMapTooltip(svg);
  tip.raise(); // ✅ 永遠浮在最上層

  const t = tip.select("text");
  t.selectAll("tspan").remove();

  const lines = String(text).split("\n");
  lines.forEach((line, i) => {
    t.append("tspan")
      .attr("x", 10)
      .attr("dy", i === 0 ? 0 : 16)
      .text(line);
  });

  const bb = t.node().getBBox();
  tip.select("rect")
    .attr("width", bb.width + 20)
    .attr("height", bb.height + 14);

  tip.style("display", null);
  moveMapTooltip(svg, event);
}


function moveMapTooltip(svg, event) {
  const tip = svg.select("g._hubTooltip");
  if (tip.empty()) return;

  tip.raise(); // ✅ 移動時也保持最上層

  const bounds = svg.property("__sphereBounds__");   // [[x0,y0],[x1,y1]]
  const legendBBox = svg.property("__legendBBox__"); // {x,y,w,h}
  const pad = 12;

  const [mx, my] = d3.pointer(event, svg.node());

  // tooltip 尺寸（已經有 rect）
  const rect = tip.select("rect").node().getBBox();
  const tw = rect.width;
  const th = rect.height;

  // 初始位置：滑鼠右下
  let x = mx + 12;
  let y = my + 12;

  // ✅ clamp 到 sphere 內（避免跑出球外）
  if (bounds) {
    const [[x0, y0], [x1, y1]] = bounds;

    // 右邊不夠 → 改放左邊
    if (x + tw + pad > x1) x = mx - tw - 12;
    // 下方不夠 → 改放上面
    if (y + th + pad > y1) y = my - th - 12;

    // 再做一次硬 clamp
    x = Math.max(x0 + pad, Math.min(x, x1 - tw - pad));
    y = Math.max(y0 + pad, Math.min(y, y1 - th - pad));
  }

  // ✅ 避開 legend（如果 tooltip 跟 legend 重疊，就往左/上推）
  if (legendBBox) {
    const overlap =
      x < legendBBox.x + legendBBox.w &&
      x + tw > legendBBox.x &&
      y < legendBBox.y + legendBBox.h &&
      y + th > legendBBox.y;

    if (overlap) {
      // 優先往左推
      x = legendBBox.x - tw - 10;
      // 如果左邊又不夠，就往上
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
  svg.select("g._hubTooltip").style("display", "none");
}


function formatHubTooltip(d) {
  const a = d.airport || {};
  const name = a.name || d.iata || "Airport";
  const city = a.city ? `, ${a.city}` : "";
  const country = a.country ? `, ${a.country}` : "";
  return `${name} (${d.iata})${city}${country}\nDepartures: ${d.count.toLocaleString()}`;
}

// ---------- legend (clearer) ----------
function drawHubLegend(svg, geoPath, maxCount, rScale) {
  const boxW = 260;
  const boxH = 92;
  const pad = 18;

  const [[x0, y0], [x1, y1]] = geoPath.bounds({ type: "Sphere" });
  const x = Math.max(x0 + pad, x1 - boxW - pad);
  const y = Math.max(y0 + pad, y0 + pad);

  const g = svg.append("g")
    .attr("class", "hub-legend")
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
    .text("Hub size = departing flights");

  g.append("text")
    .attr("x", 12)
    .attr("y", 36)
    .attr("font-size", 11)
    .attr("fill", "#6b7280")
    .text(`Max hub = ${maxCount.toLocaleString()} departures`);

  // ✅ use explicit “example sizes” labels
  const samples = [
    { label: "25%", value: Math.round(maxCount * 0.25) },
    { label: "60%", value: Math.round(maxCount * 0.6) },
    { label: "100%", value: Math.round(maxCount * 1.0) },
  ].filter((d) => d.value > 0);

  let cx = 38;
  const cy = 68;

  samples.forEach((s) => {
    g.append("circle")
      .attr("cx", cx)
      .attr("cy", cy)
      .attr("r", rScale(s.value))
      .attr("fill", HUB_FILL)
      .attr("fill-opacity", 0.65)
      .attr("stroke", "white")
      .attr("stroke-width", 0.8);

    g.append("text")
      .attr("x", cx + rScale(s.value) + 8)
      .attr("y", cy + 4)
      .attr("font-size", 11)
      .attr("fill", "#6b7280")
      .text(`${s.label}`);

    cx += 70;
  });

    // ✅ 記錄 legend 的 bbox（供 tooltip 避讓）
  const lb = g.node().getBBox();
  const t = g.attr("transform"); // translate(x,y)
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

// ---------- safety cap (if utilities capRoutes not present) ----------
function safeCapRoutes(routes, maxCount) {
  if (!routes || routes.length <= maxCount) return routes || [];

  // If your utilities.js already has capRoutes, use it (random or longFirst doesn't matter here)
  if (typeof capRoutes === "function") {
    return capRoutes(routes, maxCount, "random");
  }

  // fallback: random sample
  const arr = routes.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, maxCount);
}

// ---------- export ----------
export const hubs = { renderMap, renderSide };
