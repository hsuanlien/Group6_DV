async function renderMap(ctx) {
  const { mapSvg: svg } = ctx;
  svg.selectAll("*").remove();
  svg.append("text")
    .attr("x", 16)
    .attr("y", 28)
    .attr("class", "placeholder-text")
    .text("Elevation view placeholder");
}

async function renderSide(ctx) {
  // later draw charts into #elevation-chart-1,2,3
}

export const elevation = { renderMap, renderSide };
