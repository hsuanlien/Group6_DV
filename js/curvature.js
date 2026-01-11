async function renderMap(ctx) {
  const { mapSvg: svg } = ctx;
  svg.selectAll("*").remove();
  svg.append("text")
    .attr("x", 16)
    .attr("y", 28)
    .attr("class", "placeholder-text")
    .text("Curvature view placeholder");
}

async function renderSide(ctx) {
  // later draw charts into #curvature-chart-1
}

export const curvature = { renderMap, renderSide };