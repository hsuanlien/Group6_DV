async function renderMap(ctx) {
  const { mapSvg: svg } = ctx;
  svg.selectAll("*").remove();
  svg.append("text")
    .attr("x", 16)
    .attr("y", 28)
    .attr("class", "placeholder-text")
    .text("Hubs view placeholder");
}

async function renderSide(ctx) {
  // later draw charts into #hubs-chart-1
}

export const hubs = { renderMap, renderSide };
