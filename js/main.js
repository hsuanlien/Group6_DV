import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { routing } from "./routing.js";
import { elevation } from "./elevation.js";
import { hubs } from "./hubs.js";
import { distance } from "./distance.js";
import { curvature } from "./curvature.js";

// ----- view registry -----
const VIEWS = {
  routing,
  elevation,
  hubs,
  distance,
  curvature,
};

const VIEW_META = {
  routing: { title: "Build and visualize your European flight journey in seconds!", subtitle: "Choose a starting airport, explore reachable destinations, and automatically visualize the entire journey on the map." },
  elevation: { title: "Elevation Insights for Air Networks", subtitle: "Explore whether higher-altitude airports show different connectivity patterns and aircraft mix compared to lower-elevation airports." },
  hubs: { title: "Discover the world’s busiest airports at a glance.", subtitle: "Identify major global and regional hubs and explore how flight connectivity concentrates across the air transportation network." },
  distance: { title: "Reveal global patterns of flight distance.", subtitle: "Explore how short-, mid-, and long-haul routes are distributed across the world and how they shape the global airline network." },
  curvature: { title: "Explore the geometry of global flight routes.", subtitle: "Analyze great-circle route curvature and discover equatorial-like, mid-latitude, and polar-like routing patterns." },
};

// ----- DOM -----
const navItems = document.querySelectorAll(".nav-item");
const viewTitle = document.getElementById("view-title");
const viewSubtitle = document.getElementById("view-subtitle");
const mapSvgs = document.querySelectorAll(".map-svg");
const viewBlocks = document.querySelectorAll("[data-view-block]");
const observationsSection = document.getElementById("observations");
const obsViews = document.querySelectorAll("[data-obs-view]");

let activeViewKey = "routing";

// ----- helpers -----
function showMapSvg(viewKey) {
  mapSvgs.forEach((s) => s.classList.toggle("is-visible", s.id === `map-svg-${viewKey}`));
}

function showSideBlock(viewKey) {
  viewBlocks.forEach((block) => {
    block.classList.toggle("is-visible", block.dataset.viewBlock === viewKey);
  });
}

function sizeMapSvg(viewKey) {
  const wrap = document.getElementById("map-wrap");
  const svg = d3.select(`#map-svg-${viewKey}`);
  svg.attr("width", wrap.clientWidth).attr("height", wrap.clientHeight);
}

function setAllMapSvgSizes() {
  const wrap = document.getElementById("map-wrap");
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;

  mapSvgs.forEach((node) => d3.select(node).attr("width", width).attr("height", height));
}

function getCtx(viewKey) {
  const wrap = document.getElementById("map-wrap");
  return {
    viewKey,
    width: wrap.clientWidth,
    height: wrap.clientHeight,
    // convenience handles
    mapSvg: d3.select(`#map-svg-${viewKey}`),
    sideRoot: document.querySelector(`[data-view-block="${viewKey}"]`),
  };
}

async function render(viewKey) {
  const view = VIEWS[viewKey];
  const ctx = getCtx(viewKey);

  if (!ctx.width || !ctx.height || ctx.width < 10 || ctx.height < 10) {
    console.warn("Skip render: invalid size", ctx);
    return;
  }

  sizeMapSvg(viewKey);
  await view.renderMap(ctx);
  await view.renderSide(ctx);
}


async function setActiveView(viewKey) {
  activeViewKey = viewKey;

  // tabs
  navItems.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === viewKey));

  // title/subtitle
  viewTitle.textContent = VIEW_META[viewKey].title;
  viewSubtitle.textContent = VIEW_META[viewKey].subtitle;

  // panels
  showSideBlock(viewKey);
  showMapSvg(viewKey);

  // observations: hidden on routing
  observationsSection.classList.toggle("is-hidden", viewKey === "routing");
  obsViews.forEach((v) => v.classList.toggle("is-visible", v.dataset.obsView === viewKey));

  // render actual view
  await render(viewKey);
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => setActiveView(btn.dataset.view).catch(console.error));
});

window.addEventListener("resize", () => {
  setAllMapSvgSizes();
  render(activeViewKey).catch(console.error);
});

// init
setAllMapSvgSizes();
setActiveView(activeViewKey).catch(console.error);