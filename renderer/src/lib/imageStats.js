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
    sharpness: laplacianVar(gray, small.w, small.h),
    sampledW: small.w,
    sampledH: small.h,
  };
}
