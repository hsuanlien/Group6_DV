const WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";
const EURO_BBOX = { lonMin: -15, lonMax: 40, latMin: 35, latMax: 72 };

let _worldTopo = null;
let _europeFC = null;

function bboxIntersects(feature, bbox) {
    const b = d3.geoBounds(feature); // [[minLon, minLat], [maxLon, maxLat]]
    const minLon = b[0][0], minLat = b[0][1];
    const maxLon = b[1][0], maxLat = b[1][1];

    // intersection test
    const lonOverlap = maxLon >= bbox.lonMin && minLon <= bbox.lonMax;
    const latOverlap = maxLat >= bbox.latMin && minLat <= bbox.latMax;
    return lonOverlap && latOverlap;
}

async function loadEuropeFC() {
    if (_europeFC) return _europeFC;

    if (!_worldTopo) _worldTopo = await d3.json(WORLD_ATLAS_URL);

    const countries = topojson.feature(_worldTopo, _worldTopo.objects.countries);

    const europe = countries.features.filter((f) => bboxIntersects(f, EURO_BBOX));

    _europeFC = { type: "FeatureCollection", features: europe };
    return _europeFC;
}

function ensureLayers(svg) {
    // Create stable layers once; don't wipe whole svg later
    const root = svg.selectAll("g.root").data([null]).join("g").attr("class", "root");
    root.selectAll("g.basemap").data([null]).join("g").attr("class", "basemap");
    root.selectAll("g.routes").data([null]).join("g").attr("class", "routes");
    root.selectAll("g.nodes").data([null]).join("g").attr("class", "nodes");
    return root;
}

function clampProjectionToFeature(projection, featureCollection, width, height, pad = 0) {
    const path = d3.geoPath(projection);
    const b = path.bounds(featureCollection); // [[x0,y0],[x1,y1]]

    const x0 = b[0][0], y0 = b[0][1];
    const x1 = b[1][0], y1 = b[1][1];

    let dx = 0;
    let dy = 0;

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

    basemap.selectAll("*").remove(); // only clear basemap layer

    // 1) Fit Europe to the SVG area
    const projection = d3.geoMercator().fitExtent(
        [[16, 16], [width, height]],
        europeFC
    );

    // 2) Re-center so Germany's centroid is at the SVG center
    // Germany numeric id in world-atlas is 276
    const germanyFeature = europeFC.features.find((f) => +f.id === 276);

    if (germanyFeature) {
        const germanyLonLat = d3.geoCentroid(germanyFeature); // [lon, lat]
        const germanyXY = projection(germanyLonLat);          // [x, y] in pixels

        const target = [width / 2, height * 0.05];
        const t = projection.translate(); // [tx, ty]

        projection.translate([
            t[0] + (target[0] - germanyXY[0]),
            t[1] + (target[1] - germanyXY[1]),
        ]);

        // after centering on Germany, ensure whole EuropeFC stays inside the viewport
        clampProjectionToFeature(projection, europeFC, width, height, 16);
    } else {
        console.warn("Germany feature (id=276) not found in europeFC.");
    }

    const path = d3.geoPath(projection);

    basemap
        .selectAll("path.country")
        .data(europeFC.features)
        .join("path")
        .attr("class", "country")
        .attr("d", path);

    // helpful: keep projection on svg for later route/node placement
    svg.property("__projection__", projection);

    // (optional) debug dot at Germany centroid
    if (germanyFeature) {
        const [x, y] = projection(d3.geoCentroid(germanyFeature));
        basemap
            .selectAll("circle.de-center")
            .data([null])
            .join("circle")
            .attr("class", "de-center")
            .attr("cx", x)
            .attr("cy", y)
            .attr("r", 3);
    }
}

async function renderMap(ctx) {
    const { mapSvg: svg, width, height } = ctx;

    const europeFC = await loadEuropeFC();
    drawEuropeBasemap(svg, width, height, europeFC);

    // placeholder label (optional)
    svg.selectAll("text.routing-label")
        .data([null])
        .join("text")
        .attr("class", "routing-label placeholder-text")
        .attr("x", 16)
        .attr("y", 28)
        .text("Routing: Europe basemap (placeholder)");
}

async function renderSide(ctx) {
    // For now: leave the DOM as-is (your dropdown + stack already exist)
    // This is the place to populate dropdown, attach listeners once, update stack, etc.

    // Example “reserved hook”:
    // const select = ctx.sideRoot.querySelector("#routing-origin");
    // if (!select.dataset.bound) { ...; select.dataset.bound = "1"; }
}

export const routing = { renderMap, renderSide };
