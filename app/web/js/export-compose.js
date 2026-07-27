// Composes a TiTiler /cog/bbox PNG into a complete map figure: title block,
// legend (color ramp / categorical classes / RGB bands), scale bar, north
// arrow, and attribution, drawn on a white footer band below the map image.
//
// Pure drawing module: no DOM lookups, no globals. The caller materializes all
// styling metadata into `opts` so this stays testable in isolation.
//
// opts = {
//   title:        string,
//   subtitle:     string,          // e.g. "R3D009 · 2023 · viridis"
//   attribution:  string,
//   groundWidthM: number,          // ground width of the map image, meters
//   legend:
//     | { kind: "ramp",    stops: string[], min: string, max: string, units: string }
//     | { kind: "classes", stops: string[], min: number, count: number }
//     | { kind: "bands",   bands: [{ name: string, color: string }] }
// }
// Returns a Promise<Blob> (PNG).

function sampleStops(stops, t) {
  const rgb = stops.map((h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  if (t <= 0) return `rgb(${rgb[0].join(",")})`;
  if (t >= 1) return `rgb(${rgb[rgb.length - 1].join(",")})`;
  const pos = t * (rgb.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = rgb[i], b = rgb[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

// Largest "nice" length (1/2/5 × 10^k meters) whose drawn width fits maxPx.
function niceScaleLength(metersPerPx, maxPx) {
  const maxMeters = metersPerPx * maxPx;
  const k = Math.floor(Math.log10(maxMeters));
  for (const m of [5, 2, 1]) {
    const len = m * 10 ** k;
    if (len <= maxMeters) return len;
  }
  return 10 ** (k - 1) * 5;
}

function formatMeters(m) {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

function drawScaleBar(ctx, x, y, metersPerPx, s, ink) {
  const lenM = niceScaleLength(metersPerPx, 170 * s);
  const lenPx = lenM / metersPerPx;
  const h = 6 * s;
  // Classic alternating two-segment bar.
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, s * 0.8);
  ctx.fillStyle = ink;
  ctx.fillRect(x, y, lenPx / 2, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + lenPx / 2, y, lenPx / 2, h);
  ctx.strokeRect(x, y, lenPx, h);
  ctx.fillStyle = ink;
  ctx.font = `${10 * s}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText("0", x, y - 2 * s);
  ctx.textAlign = "right";
  ctx.fillText(formatMeters(lenM), x + lenPx, y - 2 * s);
  return lenPx;
}

function drawNorthArrow(ctx, cx, cy, s, ink) {
  const h = 20 * s;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, s * 0.8);
  ctx.font = `bold ${11 * s}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText("N", cx, cy - h / 2 - 2 * s);
  // Half-filled arrowhead (left solid, right outline) on a stem.
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx - 6 * s, cy + h / 2);
  ctx.lineTo(cx, cy + h / 4);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + 6 * s, cy + h / 2);
  ctx.lineTo(cx, cy + h / 4);
  ctx.closePath();
  ctx.stroke();
}

// Draws the legend with its top-right corner at (right, top); returns height used.
function drawLegend(ctx, legend, right, top, s, ink, faint) {
  const barW = 200 * s, barH = 12 * s;
  const x = right - barW;
  ctx.font = `${10 * s}px system-ui, sans-serif`;

  if (legend.kind === "ramp") {
    const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
    legend.stops.forEach((c, i) => grad.addColorStop(i / (legend.stops.length - 1), c));
    ctx.fillStyle = grad;
    ctx.fillRect(x, top, barW, barH);
    ctx.strokeStyle = faint;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, top, barW, barH);
    ctx.fillStyle = ink;
    ctx.textBaseline = "top";
    const ly = top + barH + 3 * s;
    ctx.textAlign = "left";
    ctx.fillText(legend.min, x, ly);
    ctx.textAlign = "right";
    ctx.fillText(legend.max, x + barW, ly);
    if (legend.units) {
      ctx.textAlign = "center";
      ctx.fillStyle = faint;
      ctx.fillText(legend.units, x + barW / 2, ly);
    }
    return barH + 16 * s;
  }

  if (legend.kind === "classes") {
    const maxShown = 12;
    const shown = Math.min(legend.count, maxShown);
    const sw = Math.min(24 * s, barW / shown);
    const x0 = right - sw * shown;
    for (let i = 0; i < shown; i++) {
      const t = legend.count <= 1 ? 0.5 : i / (legend.count - 1);
      ctx.fillStyle = sampleStops(legend.stops, t);
      ctx.fillRect(x0 + i * sw, top, sw, barH + 4 * s);
      ctx.fillStyle = i / shown > 0.5 ? "#000000" : "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(legend.min + i), x0 + (i + 0.5) * sw, top + (barH + 4 * s) / 2);
    }
    ctx.strokeStyle = faint;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, top, sw * shown, barH + 4 * s);
    let used = barH + 4 * s;
    if (legend.count > maxShown) {
      ctx.fillStyle = faint;
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(`… +${legend.count - maxShown} more classes`, right, top + used + 3 * s);
      used += 15 * s;
    }
    return used + 2 * s;
  }

  // bands
  let bx = right;
  ctx.textBaseline = "middle";
  const chip = 12 * s;
  [...legend.bands].reverse().forEach((b) => {
    ctx.textAlign = "right";
    ctx.fillStyle = ink;
    const w = ctx.measureText(b.name).width;
    ctx.fillText(b.name, bx, top + chip / 2);
    bx -= w + 4 * s;
    ctx.fillStyle = b.color;
    ctx.fillRect(bx - chip, top, chip, chip);
    bx -= chip + 12 * s;
  });
  return chip + 6 * s;
}

export async function composeExportPng(blob, opts) {
  const img = await createImageBitmap(blob);
  const s = Math.min(4, Math.max(1, img.width / 900));
  const minW = 560 * s;
  const W = Math.max(img.width, minW);
  const pad = 14 * s;
  const legendH = 34 * s; // ramp/bands baseline; classes may add rows below text block
  const footerH = pad + 20 * s + 15 * s + 6 * s + Math.max(26 * s, legendH) + 14 * s + pad;
  const H = img.height + footerH;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const ink = "#1a1a1a", faint = "#666666";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const imgX = Math.round((W - img.width) / 2);
  ctx.drawImage(img, imgX, 0);
  ctx.strokeStyle = "#bbbbbb";
  ctx.lineWidth = 1;
  ctx.strokeRect(imgX + 0.5, 0.5, img.width - 1, img.height - 1);

  // ---- footer ----
  let y = img.height + pad;
  ctx.fillStyle = ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `bold ${14 * s}px system-ui, sans-serif`;
  const legendW = 210 * s;
  ctx.fillText(opts.title, pad, y, W - legendW - 3 * pad);
  ctx.font = `${11 * s}px system-ui, sans-serif`;
  ctx.fillStyle = faint;
  ctx.fillText(opts.subtitle, pad, y + 20 * s, W - legendW - 3 * pad);

  if (opts.legend) drawLegend(ctx, opts.legend, W - pad, y, s, ink, faint);

  // Scale bar + north arrow row, bottom-aligned in the footer.
  const rowY = img.height + footerH - pad - 8 * s;
  const metersPerPx = opts.groundWidthM / img.width;
  const barPx = drawScaleBar(ctx, pad, rowY, metersPerPx, s, ink);
  drawNorthArrow(ctx, pad + barPx + 34 * s, rowY + 2 * s, s, ink);

  ctx.fillStyle = faint;
  ctx.font = `${9.5 * s}px system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(opts.attribution, W - pad, img.height + footerH - pad + 4 * s);

  img.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/png")
  );
}
