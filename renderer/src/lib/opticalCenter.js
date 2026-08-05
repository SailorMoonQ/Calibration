// Optical-centre diagnostics and ROI solving.
//
// A lens module's optical axis rarely lands on the sensor's geometric centre —
// assembly tolerance, lens-mount offset and batch variation shift the principal
// point (cx, cy) by tens or hundreds of pixels. The picture still "looks
// straight", but the distortion centre is off, so undistortion is asymmetric at
// the edges and multi-camera rigs never quite line up.
//
// Everything here is pure arithmetic on a 3×3 K and a [w, h] frame size, so it
// can be tested exactly rather than eyeballed on a preview.
//
// K layout matches what the backend returns: [[fx,0,cx],[0,fy,cy],[0,0,1]].

const DEG = 180 / Math.PI;

function kParts(K) {
  if (!K || K.length < 3 || !K[0] || !K[1]) return null;
  const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
  if (![fx, fy, cx, cy].every(Number.isFinite)) return null;
  if (fx <= 0 || fy <= 0) return null;
  return { fx, fy, cx, cy };
}

function sizeParts(size) {
  if (!size || size.length < 2) return null;
  const w = size[0], h = size[1];
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

// How far the principal point sits from the frame centre. Positive dx is right,
// positive dy is down — the same convention as image coordinates, so the sign
// can be read straight off the overlay.
export function centerOffset(K, size) {
  const k = kParts(K);
  const s = sizeParts(size);
  if (!k || !s) return null;
  const dx = k.cx - s.w / 2;
  const dy = k.cy - s.h / 2;
  return {
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    // As a share of the frame, which is what tells you whether an offset is a
    // rounding artefact or a mounting problem.
    fracX: dx / s.w,
    fracY: dy / s.h,
  };
}

// Real field of view from the focal lengths, in degrees. This is the honest
// number for the lens as mounted — not the figure on the datasheet, which
// assumes a perfectly centred sensor and the full array.
export function fieldOfView(K, size) {
  const k = kParts(K);
  const s = sizeParts(size);
  if (!k || !s) return null;
  const horizontal = 2 * Math.atan(s.w / (2 * k.fx)) * DEG;
  const vertical = 2 * Math.atan(s.h / (2 * k.fy)) * DEG;
  // The diagonal is computed from the diagonal's own angular extent, not from
  // combining the two above — those are angles, and angles do not add in
  // quadrature.
  const diagPx = Math.hypot(s.w, s.h);
  const fDiag = Math.hypot(s.w, s.h) / Math.hypot(s.w / k.fx, s.h / k.fy);
  const diagonal = 2 * Math.atan(diagPx / (2 * fDiag)) * DEG;
  return { horizontal, vertical, diagonal };
}

// The largest window centred on the optical axis that still fits in the frame.
//
// To put the optical axis in the middle of the output, the crop must be centred
// on (cx, cy). The biggest such window is bounded by whichever side the axis is
// closest to:
//     width  = 2 · min(cx, W − cx)
//     height = 2 · min(cy, H − cy)
// so a large offset costs a large share of the frame — which is exactly the
// number an operator needs to decide between cropping and re-seating the lens.
export function maxCenteredRoi(K, size) {
  const k = kParts(K);
  const s = sizeParts(size);
  if (!k || !s) return null;
  const halfW = Math.min(k.cx, s.w - k.cx);
  const halfH = Math.min(k.cy, s.h - k.cy);
  const width = Math.max(0, Math.floor(2 * halfW));
  const height = Math.max(0, Math.floor(2 * halfH));
  return {
    left: Math.round(k.cx - width / 2),
    top: Math.round(k.cy - height / 2),
    width,
    height,
  };
}

// A window of the requested size, still centred on the optical axis. Clamped to
// what actually fits; `clamped` says whether the request had to be reduced, so
// the UI can show the real number rather than the one that was typed.
export function roiFor(K, size, wantW, wantH) {
  const max = maxCenteredRoi(K, size);
  if (!max) return null;
  const k = kParts(K);
  let width = Math.max(2, Math.floor(wantW));
  let height = Math.max(2, Math.floor(wantH));
  const clamped = width > max.width || height > max.height;
  width = Math.min(width, max.width);
  height = Math.min(height, max.height);
  return {
    left: Math.round(k.cx - width / 2),
    top: Math.round(k.cy - height / 2),
    width,
    height,
    clamped,
  };
}

// K after cropping. A crop is a pure translation of the image origin, so the
// focal lengths are untouched and only the principal point moves. Radial
// distortion coefficients are likewise unaffected — they are defined relative to
// the principal point, which is exactly what we are re-centring.
export function kAfterRoi(K, roi) {
  const k = kParts(K);
  if (!k || !roi) return null;
  return [
    [k.fx, 0, k.cx - roi.left],
    [0, k.fy, k.cy - roi.top],
    [0, 0, 1],
  ];
}

// Share of the frame area a crop throws away — the price of centring the axis.
export function frameLoss(size, roi) {
  const s = sizeParts(size);
  if (!s || !roi || !roi.width || !roi.height) return null;
  const kept = (roi.width * roi.height) / (s.w * s.h);
  return { kept, lost: 1 - kept };
}

// Everything the panel needs, from one calibration and one frame size.
// Returns null rather than a half-filled object when the inputs are unusable, so
// a caller cannot accidentally render zeros as if they were measurements.
export function analyzeOpticalCenter(K, size) {
  const offset = centerOffset(K, size);
  const fov = fieldOfView(K, size);
  const roi = maxCenteredRoi(K, size);
  if (!offset || !fov || !roi) return null;
  return {
    offset,
    fov,
    roi,
    kAfter: kAfterRoi(K, roi),
    fovAfter: fieldOfView(K, [roi.width, roi.height]),
    loss: frameLoss(size, roi),
  };
}
