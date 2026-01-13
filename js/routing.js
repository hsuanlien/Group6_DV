import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { initDataStore } from "./utilities.js";

const WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";
const EURO_BBOX = { lonMin: -25, lonMax: 40, latMin: 35, latMax: 72 };

// --- routing local state (we'll expand later) ---
const routingState = {
    homeIATA: null,          // the initial departing airport (home)
    currentIATA: null,       // the current airport (the black dot)
    routableOriginSet: null, // strict set: DST=='E' + valid IATA + is source in routes
    // plan:
    airports: [],            // ordered list of IATA in the plan (starts with home)
    legs: [],                // ordered list of {from, to}
    isComplete: false,
};

let _worldTopo = null;
let _europeFC = null;

function centroidInBBox(feature, bbox) {
    const [lon, lat] = d3.geoCentroid(feature); // [lon, lat]
    return (
        lon >= bbox.lonMin && lon <= bbox.lonMax &&
        lat >= bbox.latMin && lat <= bbox.latMax
    );
}

async function loadEuropeFC() {
    if (_europeFC) return _europeFC;
    if (!_worldTopo) _worldTopo = await d3.json(WORLD_ATLAS_URL);

    const countries = topojson.feature(_worldTopo, _worldTopo.objects.countries);

    const europe = countries.features.filter((f) => centroidInBBox(f, EURO_BBOX));

    _europeFC = { type: "FeatureCollection", features: europe };
    return _europeFC;
}

function makeEuropeContainsFn(europeFC) {
    // returns (lon,lat) => boolean
    // europeFC.features are GeoJSON country polygons
    const features = europeFC.features;

    return (lon, lat) => {
        if (lon == null || lat == null) return false;
        const p = [lon, lat];
        // check if point is inside ANY europe polygon
        for (const f of features) {
            if (d3.geoContains(f, p)) return true;
        }
        return false;
    };
}

function ensureLayers(svg) {
    const root = svg.selectAll("g.root").data([null]).join("g").attr("class", "root");
    root.selectAll("g.basemap").data([null]).join("g").attr("class", "basemap");
    root.selectAll("g.routes").data([null]).join("g").attr("class", "routes");
    root.selectAll("g.nodes").data([null]).join("g").attr("class", "nodes");
    return root;
}

function getProjection(svg) {
    const node = svg.node();
    return node?.__projection__ ?? null;
}

function setProjection(svg, projection) {
    const node = svg.node();
    if (node) node.__projection__ = projection;
}

// Keep zoom state on the SVG node
function getZoom(svg) {
    const node = svg.node();
    return node?.__zoomBehavior__ ?? null;
}
function setZoom(svg, zoomBehavior) {
    const node = svg.node();
    if (node) node.__zoomBehavior__ = zoomBehavior;
}

// Apply zoom transform to ALL map layers consistently
function applyZoomTransform(svg, transform) {
    const root = svg.select("g.root");
    // everything scales/pans together, including countries, routes, nodes
    root.attr("transform", transform);
}

function clampProjectionToFeature(projection, featureCollection, width, height, pad = 0) {
    const path = d3.geoPath(projection);
    const b = path.bounds(featureCollection);

    const x0 = b[0][0], y0 = b[0][1];
    const x1 = b[1][0], y1 = b[1][1];

    let dx = 0, dy = 0;

    if (x0 < pad) dx = pad - x0;
    if (x1 > width - pad) dx = (width - pad) - x1;

    if (y0 < pad) dy = pad - y0;
    if (y1 > height - pad) dy = (height - pad) - y1;

    if (dx !== 0 || dy !== 0) {
        const t = projection.translate();
        projection.translate([t[0] + dx, t[1] + dy]);
    }
}

function drawEuropeBasemap(svg, width, height, europeFC) {
    const root = ensureLayers(svg);
    const basemap = root.select("g.basemap");

    basemap.selectAll("*").remove();

    // Geography-respecting projection
    // Use padding so countries don't touch the border
    const pad = 18;
    const projection = d3.geoMercator().fitExtent(
        [[pad, pad], [width - pad, height - pad]],
        europeFC
    );

    const path = d3.geoPath(projection);

    basemap
        .selectAll("path.country")
        .data(europeFC.features)
        .join("path")
        .attr("class", "country")
        .attr("d", path);

    // store projection
    setProjection(svg, projection);

    // Setup zoom once
    let zoom = getZoom(svg);
    if (!zoom) {
        zoom = d3.zoom()
            .scaleExtent([1, 12]) // adjust if you want more zoom
            .on("zoom", (event) => {
                applyZoomTransform(svg, event.transform);
            });

        svg.call(zoom);
        setZoom(svg, zoom);
    }

    // Reset zoom to identity when basemap is re-created (e.g. resize / rerender)
    svg.call(zoom.transform, d3.zoomIdentity);
}

function projectPoint(projection, airport) {
    if (!airport || airport.lon == null || airport.lat == null) return null;
    return projection([airport.lon, airport.lat]);
}

function zoomToPoints(ctx, points, paddingPx = 60) {
    const svg = ctx.mapSvg;
    const zoom = getZoom(svg);
    const projection = getProjection(svg);
    if (!zoom || !projection) return;
    if (!points || points.length === 0) return;

    // Compute pixel bounds of projected points
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);

    const w = ctx.width;
    const h = ctx.height;

    const dx = Math.max(1, x1 - x0);
    const dy = Math.max(1, y1 - y0);

    // Scale so bounds fit within viewport (with padding)
    const scale = Math.max(
        1,
        Math.min(12, 0.9 / Math.max(dx / (w - paddingPx), dy / (h - paddingPx)))
    );

    // Center of bounds
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    // Build transform that brings (cx,cy) to the center
    const transform = d3.zoomIdentity
        .translate(w / 2, h / 2)
        .scale(scale)
        .translate(-cx, -cy);

    svg.transition().duration(500).call(zoom.transform, transform);
}

function zoomToCurrentAirport(ctx, store) {
    const svg = ctx.mapSvg;
    const projection = getProjection(svg);
    if (!projection) return;

    const airportsByIATA = store.indexes.airportsByIATA;
    const cur = airportsByIATA.get(routingState.currentIATA);
    const p = projectPoint(projection, cur);
    if (!p) return;

    // Focus on current airport with modest zoom
    zoomToPoints(ctx, [p], 240);
}

function zoomToPlannedRoute(ctx, store) {
    const svg = ctx.mapSvg;
    const projection = getProjection(svg);
    if (!projection) return;

    const airportsByIATA = store.indexes.airportsByIATA;
    const pts = routingState.airports
        .map(iata => airportsByIATA.get(iata))
        .map(a => projectPoint(projection, a))
        .filter(Boolean);

    if (pts.length === 0) return;
    zoomToPoints(ctx, pts, 80);
}

// ------------------------------
// Tooltip
// ------------------------------
function getOrCreateTooltip() {
    const wrap = document.getElementById("map-wrap");
    if (!wrap) return null;

    let tip = wrap.querySelector(".routing-tooltip");
    if (!tip) {
        tip = document.createElement("div");
        tip.className = "routing-tooltip";
        tip.style.position = "absolute";
        tip.style.pointerEvents = "none";
        tip.style.display = "none";
        tip.style.padding = "6px 8px";
        tip.style.borderRadius = "6px";
        tip.style.fontSize = "12px";
        tip.style.background = "rgba(0,0,0,0.8)";
        tip.style.color = "white";
        tip.style.zIndex = "10";
        wrap.style.position = wrap.style.position || "relative";
        wrap.appendChild(tip);
    }
    return tip;
}

function showTooltip(tip, text, x, y) {
    if (!tip) return;
    tip.textContent = text;
    tip.style.left = `${x + 10}px`;
    tip.style.top = `${y + 10}px`;
    tip.style.display = "block";
}

function hideTooltip(tip) {
    if (!tip) return;
    tip.style.display = "none";
}

// ------------------------------
// Routing drawing helpers
// ------------------------------
function buildEuropeAirportSet(store, europeFC) {
    const airportsByIATA = store.indexes.airportsByIATA;
    const contains = makeEuropeContainsFn(europeFC);

    const set = new Set();

    for (const row of store.raw.airportsRaw) {
        const dst = (row.DST ?? "").trim();
        const iata = String(row.IATA ?? "").trim();

        if (dst !== "E") continue;
        if (!iata || iata === "\\N") continue;

        const a = airportsByIATA.get(iata);
        if (!a || a.lon == null || a.lat == null) continue;

        // geographic filter: must be inside the basemap region
        if (!contains(a.lon, a.lat)) continue;

        set.add(iata);
    }

    return set;
}

async function buildRoutableOriginSet(store) {
    // Step 1: base Europe airports (DST==E + valid IATA + inside europeFC)
    const europeFC = await loadEuropeFC();
    const europeAirportSet = buildEuropeAirportSet(store, europeFC);

    // Step 2: must be a SOURCE airport in routesDerived, and destination also in europeAirportSet
    // routesDerived already filters out routes that can't join to airports + coords
    const sourceSet = new Set();
    for (const r of store.routesDerived) {
        const s = r.src?.iata;
        const t = r.dst?.iata;
        if (!s || !t) continue;
        if (!europeAirportSet.has(s)) continue;
        if (!europeAirportSet.has(t)) continue;
        sourceSet.add(s);
    }

    return { sourceSet, europeAirportSet };
}

function quadCurvePath(x1, y1, x2, y2, bend = 0.18) {
    // control point = midpoint + perpendicular offset
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;

    // unit perpendicular
    const nx = -dy / len;
    const ny = dx / len;

    const offset = len * bend;
    const cx = mx + nx * offset;
    const cy = my + ny * offset;

    return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
}

// ------------------------------
// Route stack UI
// ------------------------------
function renderRouteStack(ctx, store) {
    const ol = document.getElementById("routing-stack");
    if (!ol) return;

    const airportsByIATA = store.indexes.airportsByIATA;

    ol.innerHTML = "";

    for (let i = 0; i < routingState.airports.length; i++) {
        const iata = routingState.airports[i];
        const a = airportsByIATA.get(iata);
        const name = a?.name ?? iata;

        const li = document.createElement("li");
        li.textContent = `${name} (${iata})`;

        if (iata === routingState.currentIATA && !routingState.isComplete) {
            li.style.fontWeight = "700";
        }
        ol.appendChild(li);
    }

    if (routingState.isComplete) {
        const done = document.createElement("li");
        done.textContent = "Route completed!";
        done.style.marginTop = "8px";
        done.style.fontWeight = "700";
        done.style.fontSize = "20px";
        done.style.listStyle = "none";
        done.style.paddingLeft = "0";
        ol.appendChild(done);

        // zoom to show the entire planned route
        zoomToPlannedRoute(ctx, store);
    }
}

function resetPlan() {
    routingState.homeIATA = null;
    routingState.currentIATA = null;
    routingState.airports = [];
    routingState.legs = [];
    routingState.isComplete = false;
}

// ------------------------------
// Cancellation helpers
// ------------------------------
function truncatePlanAfterAirport(iata) {
    // keep airports up to (and including) iata, remove later legs/airports
    const idx = routingState.airports.indexOf(iata);
    if (idx < 0) return;

    routingState.airports = routingState.airports.slice(0, idx + 1);
    routingState.legs = routingState.legs.slice(0, Math.max(0, idx)); // legs count = airports-1
    routingState.currentIATA = iata;
    routingState.isComplete = false;
}

function truncatePlanAfterLeg(from, to) {
    // find the leg index
    const k = routingState.legs.findIndex((l) => l.from === from && l.to === to);
    if (k < 0) return;

    // keep legs before this one
    routingState.legs = routingState.legs.slice(0, k);
    // airports = home + each kept leg.to
    routingState.airports = routingState.airports.slice(0, k + 1);
    routingState.currentIATA = routingState.airports[routingState.airports.length - 1] ?? routingState.homeIATA;
    routingState.isComplete = false;
}

// ------------------------------
// Core map update
// ------------------------------
function updateRoutingMap(ctx, store) {
    const svg = ctx.mapSvg;
    if (!svg || (svg.empty && svg.empty())) return;

    const svgNode = svg.node();
    const projection = svgNode?.__projection__;
    if (!projection) return;

    const root = ensureLayers(svg);
    const routesLayer = root.select("g.routes");
    const nodesLayer = root.select("g.nodes");

    routesLayer.selectAll("*").remove();
    nodesLayer.selectAll("*").remove();

    const tip = getOrCreateTooltip();

    // need a current airport to show routing choices
    const currentIATA = routingState.currentIATA;
    if (!currentIATA) return;

    // cache strict set
    if (!routingState.routableOriginSet) {
        routingState.routableOriginSet = buildRoutableOriginSet(store);
    }

    const airportsByIATA = store.indexes.airportsByIATA;

    // draw already-chosen thick legs first
    const chosenLegs = routingState.legs.map((l) => {
        const src = airportsByIATA.get(l.from);
        const dst = airportsByIATA.get(l.to);
        return src && dst ? { from: l.from, to: l.to, src, dst } : null;
    }).filter(Boolean);

    routesLayer
        .selectAll("path.chosen-link")
        .data(chosenLegs, (d) => `${d.from}->${d.to}`)
        .join("path")
        .attr("class", "chosen-link")
        .attr("fill", "none")
        .attr("stroke", "#111")
        .attr("stroke-opacity", 0.9)
        .attr("stroke-width", 3)
        .attr("d", (d) => {
            const [x1, y1] = projection([d.src.lon, d.src.lat]);
            const [x2, y2] = projection([d.dst.lon, d.dst.lat]);
            return quadCurvePath(x1, y1, x2, y2);
        })
        .style("cursor", "pointer")
        .on("dblclick", (event, d) => {
            event.preventDefault();
            event.stopPropagation();
            truncatePlanAfterLeg(d.from, d.to);
            renderRouteStack(ctx, store);
            updateRoutingMap(ctx, store);
        })
        .on("pointerenter", (event, d) => showTooltip(tip, `${d.from} → ${d.to}`, event.offsetX, event.offsetY))
        .on("pointermove", (event, d) => showTooltip(tip, `${d.from} → ${d.to}`, event.offsetX, event.offsetY))
        .on("pointerleave", () => hideTooltip(tip));

    // draw nodes for all airports in the plan:
    // - all locked (except current) red
    // - current black (unless complete)
    const planNodes = routingState.airports
        .map((iata) => airportsByIATA.get(iata))
        .filter((a) => a && a.iata && a.lat != null && a.lon != null);

    nodesLayer
        .selectAll("circle.plan-node")
        .data(planNodes, (d) => d.iata)
        .join("circle")
        .attr("class", "plan-node")
        .attr("cx", (d) => projection([d.lon, d.lat])[0])
        .attr("cy", (d) => projection([d.lon, d.lat])[1])
        .attr("r", (d) => (d.iata === routingState.currentIATA && !routingState.isComplete ? 2 : 1.5))
        .attr("fill", (d) => {
            if (routingState.isComplete) return "red";
            return d.iata === routingState.currentIATA ? "black" : "red";
        })
        .style("cursor", (d) => {
            // origin can't be canceled by node dblclick; others can
            if (d.iata === routingState.homeIATA) return "default";
            return "pointer";
        })
        .on("dblclick", (event, d) => {
            event.preventDefault();
            event.stopPropagation();
            if (d.iata === routingState.homeIATA) return; // don't cancel home by node dblclick
            truncatePlanAfterAirport(d.iata);
            renderRouteStack(ctx, store);
            updateRoutingMap(ctx, store);
        })
        .on("pointerenter", (event, d) => showTooltip(tip, `${d.iata}`, event.offsetX, event.offsetY))
        .on("pointermove", (event, d) => showTooltip(tip, `${d.iata}`, event.offsetX, event.offsetY))
        .on("pointerleave", () => hideTooltip(tip));

    // If route is complete, stop showing outgoing options
    if (routingState.isComplete) return;

    // outgoing options from current airport:
    // destination must be in routableOriginSet (your stricter rule)
    let outgoing = store.routesDerived.filter(
        (r) =>
            r.src?.iata === currentIATA &&
            r.dst?.iata &&
            routingState.routableOriginSet.has(r.dst.iata)
    );

    // de-dup destinations
    const byKey = new Map();
    for (const r of outgoing) {
        const k = `${r.src.iata}->${r.dst.iata}`;
        if (!byKey.has(k)) byKey.set(k, r);
    }
    outgoing = Array.from(byKey.values());

    // draw "option links" (thin), on top of chosen links
    const optionSel = routesLayer
        .selectAll("path.option-link")
        .data(outgoing, (d) => `${d.src.iata}->${d.dst.iata}`)
        .join("path")
        .attr("class", "option-link")
        .attr("fill", "none")
        .attr("stroke", "#111")
        .attr("stroke-opacity", 0.55)
        .attr("stroke-width", 0.7)
        .attr("d", (d) => {
            const [x1, y1] = projection([d.src.lon, d.src.lat]);
            const [x2, y2] = projection([d.dst.lon, d.dst.lat]);
            return quadCurvePath(x1, y1, x2, y2);
        })
        .style("cursor", "pointer");

    // tooltip + choose next hop
    optionSel
        .on("pointerenter", (event, d) => showTooltip(tip, `${d.src.iata} → ${d.dst.iata}`, event.offsetX, event.offsetY))
        .on("pointermove", (event, d) => {
            const label = `${d.src.iata} → ${d.dst.iata} (${d.dst.city}, ${d.dst.country})`;
            showTooltip(tip, label, event.offsetX, event.offsetY);
        })
        .on("pointerleave", () => hideTooltip(tip))
        .on("dblclick", (event, d) => {
            event.preventDefault();
            event.stopPropagation();

            // commit this leg
            const from = d.src.iata;
            const to = d.dst.iata;

            routingState.legs.push({ from, to });
            routingState.airports.push(to);
            routingState.currentIATA = to;

            // complete if loop back home
            if (routingState.homeIATA && to === routingState.homeIATA && routingState.airports.length > 1) {
                routingState.isComplete = true;
                zoomToPlannedRoute(ctx, store);
            }

            renderRouteStack(ctx, store);
            updateRoutingMap(ctx, store);
            zoomToCurrentAirport(ctx, store);   // focuses on new current airport
        });
}

// ------------------------------
// View lifecycle
// ------------------------------
async function renderMap(ctx) {
    const { mapSvg: svg, width, height } = ctx;
    if (!svg || (svg.empty && svg.empty())) return;

    const europeFC = await loadEuropeFC();
    drawEuropeBasemap(svg, width, height, europeFC);

    svg.selectAll("text.routing-label")
        .data([null])
        .join("text")
        .attr("class", "routing-label placeholder-text")
        .attr("x", 16)
        .attr("y", 28);

    const store = await initDataStore();
    updateRoutingMap(ctx, store);
    renderRouteStack(ctx, store);
}

async function renderSide(ctx) {
    const store = await initDataStore();

    const select = ctx.sideRoot.querySelector("#routing-origin");
    const resetBtn = ctx.sideRoot.querySelector("#routing-reset");
    if (!select) return;

    if (select.dataset.bound === "1") return;
    select.dataset.bound = "1";

    // cache strict set once
    if (!routingState.routableOriginSet) {
        const { sourceSet, europeAirportSet } = await buildRoutableOriginSet(store);
        routingState.routableOriginSet = sourceSet;      // dropdown candidates
        routingState.europeAirportSet = europeAirportSet; // optional: keep for map filtering too
    }


    const airportsByIATA = store.indexes.airportsByIATA;

    const uniq = Array.from(routingState.routableOriginSet)
        .map((iata) => airportsByIATA.get(iata))
        .filter((a) => a && a.iata);

    uniq.sort(
        (a, b) =>
            d3.ascending(a.iata ?? "", b.iata ?? "") ||
            d3.ascending(a.name ?? "", b.name ?? "") ||
            d3.ascending(a.city ?? "", b.city ?? "") ||
            d3.ascending(a.country ?? "", b.country ?? "")
    );

    select.querySelectorAll("option:not([disabled])").forEach((o) => o.remove());

    for (const a of uniq) {
        const opt = document.createElement("option");
        opt.value = a.iata;
        opt.textContent = `${a.iata} - ${a.name} (${a.city}, ${a.country})`;
        select.appendChild(opt);
    }

    select.addEventListener("change", () => {
        const iata = select.value || null;

        resetPlan();
        routingState.homeIATA = iata;
        routingState.currentIATA = iata;

        if (iata) {
            routingState.airports = [iata];
        }

        renderRouteStack(ctx, store);
        updateRoutingMap(ctx, store);
        zoomToCurrentAirport(ctx, store);
    });

    if (resetBtn && !resetBtn.dataset.bound) {
        resetBtn.dataset.bound = "1";
        resetBtn.addEventListener("click", () => {
            resetPlan();
            // also reset dropdown UI to placeholder
            select.value = "";
            renderRouteStack(ctx, store);
            updateRoutingMap(ctx, store);
        });
    }
}

export const routing = { renderMap, renderSide };
