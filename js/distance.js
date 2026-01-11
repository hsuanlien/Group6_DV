async function renderMap(ctx) {
  const { mapSvg: svg } = ctx;
  svg.selectAll("*").remove();
  svg.append("text")
    .attr("x", 16)
    .attr("y", 28)
    .attr("class", "placeholder-text")
    .text("Distance view placeholder");
}

async function renderSide(ctx) {
  // later draw charts into #distance-chart-1,2
}

export const distance = { renderMap, renderSide };