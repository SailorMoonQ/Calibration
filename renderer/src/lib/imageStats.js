// Exposure/focus statistics computed from a preview frame.
//
// All pure: they take raw RGBA bytes (what `ctx.getImageData().data` hands back)
// and return numbers. No canvas, no DOM — so they can be tested headlessly, and
// so the sampling policy (how often, at what size) stays a caller decision.
//
// Everything here runs per sampled frame in the renderer process, so the cost
// matters: callers are expected to downsample first (see `downsample`). At
// 160×120 the whole set costs well under a millisecond.

// Rec. 601 luma — the same weighting the rest of the app uses for luminance
// (see detectCircleFromImageData in polarCoverage.js), kept consistent so a
// "bright" region means the same thing everywhere.
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Nearest-neighbour downsample of an RGBA buffer. Nearest rather than area
// averaging on purpose: averaging would smooth away exactly the highlight and
// shadow pixels the clipping readout exists to count.
//
// Samples the CENTRE of each destination cell, not its top-left corner. Corner
// sampling biases every reading toward the upper-left of the frame and can never
// reach the last row or column — which matters here because vignetting and
// blown highlights are usually not uniformly distributed.
export function downsample(data, w, h, tw, th) {
  if (!data || !w || !h || !tw || !th) return null;
  if (tw >= w && th >= h) return { data, w, h };
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, (((y + 0.5) * h / th) | 0));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, (((x + 0.5) * w / tw) | 0));
      const si = (sy * w + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { data: out, w: tw, h: th };
}

// Single-channel luma image — the shared input for the histogram and the
// Laplacian, so neither pays for the colour conversion twice.
export function toGray(data, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    g[p] = luma(data[i], data[i + 1], data[i + 2]);
  }
  return g;
}

export function histogram(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  return hist;
}

// Fraction of pixels pinned at the top / bottom of the range. `margin` widens
// the bands (margin=2 counts 253..255 as blown out), because a sensor rarely
// reports a clean 255 — noise and JPEG rounding land a blown highlight a couple
// of levels below the ceiling.
export function clipping(hist, margin = 2) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  if (!total) return { high: 0, low: 0, total: 0 };
  let high = 0;
  let low = 0;
  for (let i = 255; i >= 255 - margin; i--) high += hist[i];
  for (let i = 0; i <= margin; i++) low += hist[i];
  return { high: high / total, low: low / total, total };
}

// Luma level below which `p` of the pixels fall, read straight off the
// histogram.
//
// The 95th percentile is the brightness the tuner and the health checklist both
// judge by, and it has to be the same statistic the backend uses or the two
// readouts would disagree on screen. Mean is the wrong one here: on a
// calibration board the mean moves with how much board is in shot, while the p95
// tracks the white squares — the thing that must approach saturation without
// reaching it.
export function percentile(hist, p) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  if (!total) return 0;
  const want = total * p;
  let cum = 0;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= want) return i;
  }
  return 255;
}

// Mean luma, 0..255. Cheap orientation for "am I broadly too dark or too bright"
// before reading the histogram shape.
export function meanLuma(hist) {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  return total ? sum / total : 0;
}

// Variance of the Laplacian — the standard focus/sharpness proxy, and the same
// measure the capture pipeline already gates on (`meta.sharpness`), so a reading
// here is comparable to the auto-capture blur threshold.
//
// Returns 0 for images too small to convolve rather than NaN: a degenerate frame
// should read as "no detail", not poison every downstream average.
export function laplacianVar(gray, w, h) {
  if (!gray || w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// Colour cast, measured on the brightest pixels.
//
// Whatever the scene is, its highlights are the closest thing to a neutral
// reference available without a grey card: paper, a wall, a lamp and the white
// squares of a calibration board are all meant to be white, and none of them
// should favour a channel.
//
// The reason this matters here is not aesthetic. Luma weights green at 0.587, so
// a green cast inflates every brightness reading in this file — the exposure
// looks right while the red and blue channels are still dark, wasting most of
// the sensor's range on a board that is supposed to be black and white.
//
// `top` is the fraction of pixels treated as highlights. A tenth is enough to
// average out noise while staying well clear of the midtones, which carry the
// scene's own colour and would swamp the measurement.
export function colorCast(data, gray, top = 0.1) {
  const n = gray.length;
  if (!n) return null;
  const hist = histogram(gray);
  let cut = 255;
  let seen = 0;
  const want = n * top;
  for (let i = 255; i >= 0; i--) {
    seen += hist[i];
    if (seen >= want) { cut = i; break; }
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (gray[p] < cut) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (!count) return null;
  r /= count; g /= count; b /= count;
  const mean = (r + g + b) / 3;
  if (mean < 1) return null;
  const dev = [r - mean, g - mean, b - mean];
  const worst = dev.reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
  return {
    r, g, b,
    // Normalised so the number means the same at any brightness.
    cast: Math.max(...dev.map(Math.abs)) / mean,
    // Which way it leans, for a message that names the problem rather than
    // reporting an abstract ratio.
    channel: ['red', 'green', 'blue'][dev.indexOf(worst)],
    high: worst > 0,
  };
}

// One call for the whole readout, so a caller samples the canvas once.
export function frameStats(data, w, h, { targetW = 160, targetH = 120 } = {}) {
  const small = downsample(data, w, h, targetW, targetH);
  if (!small) return null;
  const gray = toGray(small.data, small.w, small.h);
  const hist = histogram(gray);
  return {
    hist,
    ...clipping(hist),
    mean: meanLuma(hist),
    p95: percentile(hist, 0.95),
    color: colorCast(small.data, gray),
    sharpness: laplacianVar(gray, small.w, small.h),
    sampledW: small.w,
    sampledH: small.h,
  };
}

// ── image-circle clipping ───────────────────────────────────────────────────

// Does the lens's image circle run off an edge of the sensor?
//
// A fisheye (or any lens whose image circle is smaller than the frame) leaves a
// dark vignette outside the circle. Where that vignette is ABSENT along an edge,
// the circle extends past it and real field of view has been lost — permanently,
// since no crop can recover pixels the sensor never received.
//
// This is a different signal from a principal-point offset: an offset only says
// the axis is not centred, while a clipped edge says the picture is incomplete.
// A lens can be perfectly centred and still clipped (circle bigger than the
// sensor), or badly offset yet fully inside it.
//
// Measured along the middle band of each edge rather than at the corners: a
// circle's corners are outside it by construction, so corners would report
// "dark" no matter how badly the circle overruns.
//
// `threshold` is the luma below which a pixel counts as vignette. 25 of 255 is
// well under any real scene content but above sensor noise in a dark frame.
export function edgeClipping(data, w, h, { threshold = 25, band = 0.34 } = {}) {
  if (!data || w < 4 || h < 4) return null;
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return luma(data[i], data[i + 1], data[i + 2]);
  };
  // Median over the band, so one specular highlight on an otherwise dark edge
  // cannot flip the verdict.
  const med = (vals) => {
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  };
  const x0 = Math.floor(w * (0.5 - band / 2)), x1 = Math.ceil(w * (0.5 + band / 2));
  const y0 = Math.floor(h * (0.5 - band / 2)), y1 = Math.ceil(h * (0.5 + band / 2));

  const horiz = (y) => { const v = []; for (let x = x0; x < x1; x++) v.push(at(x, y)); return med(v); };
  const vert = (x) => { const v = []; for (let y = y0; y < y1; y++) v.push(at(x, y)); return med(v); };

  const levels = { top: horiz(0), bottom: horiz(h - 1), left: vert(0), right: vert(w - 1) };
  const clipped = {
    top: levels.top > threshold,
    bottom: levels.bottom > threshold,
    left: levels.left > threshold,
    right: levels.right > threshold,
  };
  const edges = Object.keys(clipped).filter(k => clipped[k]);
  return {
    levels,
    clipped,
    edges,
    // All four edges lit usually means there is no vignette at all — a normal
    // rectilinear lens filling the sensor — not a catastrophically clipped
    // fisheye. Reported so the caller can stay quiet rather than cry wolf.
    anyVignette: edges.length < 4,
  };
}
