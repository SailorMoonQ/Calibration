// Turns camera controls + a live exposure reading into concrete advice.
//
// The readouts on their own ("clipped high 8%") only help someone who already
// knows what to do about them. These checks say what is wrong, why it matters
// FOR CALIBRATION specifically, and — where the fix is unambiguous — what to set.
//
// Good settings for calibration are not the same as good settings for a nice
// picture:
//   • Both ends of the range must survive. A chessboard is defined by its black
//     and white squares; blow out the whites or crush the blacks and the corner
//     between them stops existing.
//   • Noise is worse than dimness. Sub-pixel corner refinement fits a saddle to
//     the local intensity surface, and gain noise perturbs that fit directly.
//     Prefer a longer exposure over more gain, up to the motion-blur limit.
//   • Nothing may drift mid-session. Auto exposure and autofocus re-decide
//     between frames, so images captured minutes apart no longer share a camera
//     model — which is exactly what a calibration assumes they do.
//
// Pure: no DOM, no network. `controls` is the backend's control list, `stats` is
// imageStats.frameStats output. Returns [] when there is nothing to say.

// UVC defines exposure_time_absolute in units of 100 µs, so value 150 is 15 ms.
// (Some non-UVC drivers reuse the name with different units; the check degrades
// to silence rather than bad advice when the numbers look implausible.)
const EXPOSURE_UNIT_MS = 0.1;

// Handheld board capture at ~30 fps starts smearing corners past roughly 1/60 s.
const BLUR_MS = 16;

// Clipping is measured over the whole frame. A calibration board legitimately
// contains large white squares, so a few percent is normal; double digits means
// detail is actually being lost.
const CLIP_WARN = 0.03;
const CLIP_BAD = 0.08;

// Gain as a fraction of its own range. Above this, noise starts to matter more
// than the extra brightness is worth.
const GAIN_WARN = 0.45;
const GAIN_BAD = 0.75;

const byId = (controls) => Object.fromEntries((controls || []).map(c => [c.id, c]));

const frac = (c) => {
  if (!c || c.min == null || c.max == null || c.max === c.min) return null;
  return (c.value - c.min) / (c.max - c.min);
};

// Nudge a control by a fraction of its range, staying inside it.
const nudge = (c, delta) => {
  if (!c || c.min == null || c.max == null) return null;
  const span = c.max - c.min;
  const step = c.step || 1;
  let v = c.value + delta * span;
  v = Math.max(c.min, Math.min(c.max, v));
  v = c.min + Math.round((v - c.min) / step) * step;
  return Math.max(c.min, Math.min(c.max, Math.round(v)));
};

// `powerLineHz` is the local mains frequency; mismatched settings band the image
// under artificial light. Defaults to 50 (most of the world outside the Americas).
export function assessCamera({ controls, stats, powerLineHz = 50 } = {}) {
  const c = byId(controls);
  const out = [];
  const add = (id, level, action, blockedBy) =>
    out.push({ id, level, ...(action ? { action } : {}), ...(blockedBy ? { blockedBy } : {}) });

  // A one-click fix is only offered when the driver would actually accept it.
  // Writing an inactive control is silently ignored by v4l2, so a button there
  // would look like it worked and change nothing — worse than no button. When
  // that happens we say WHICH control is holding the lock instead.
  const fixVia = (control, value) => {
    if (!control || control.inactive) return [null, control?.locked_by?.id || null];
    return [{ control: control.id, value }, null];
  };

  // ── stability: nothing may re-decide itself between frames ────────────────
  const ae = c.auto_exposure || c.exposure_auto;
  if (ae) {
    // The menu value meaning "manual" is 1 on both the modern and legacy
    // spellings; anything else leaves the driver in charge.
    const manual = ae.value === 1;
    if (!manual) {
      add('autoExposure', 'bad', { control: ae.id, value: 1 });
    } else {
      add('autoExposure', 'ok');
    }
  }

  const af = c.focus_automatic_continuous || c.focus_auto;
  if (af) {
    if (af.value) add('autoFocus', 'bad', { control: af.id, value: 0 });
    else add('autoFocus', 'ok');
  }

  const awb = c.white_balance_automatic;
  if (awb && awb.value) {
    // Only a warning: white balance shifts colour, and corner detection runs on
    // luma, so it degrades consistency rather than breaking detection.
    add('autoWhiteBalance', 'warn', { control: awb.id, value: 0 });
  }

  // ── exposure level ────────────────────────────────────────────────────────
  const exp = c.exposure_time_absolute || c.exposure_absolute;
  if (stats) {
    const { high, low } = stats;
    if (high >= CLIP_BAD) {
      add('clipHigh', 'bad', ...fixVia(exp, nudge(exp, -0.15)));
    } else if (high >= CLIP_WARN) {
      add('clipHigh', 'warn', ...fixVia(exp, nudge(exp, -0.08)));
    } else if (low >= CLIP_BAD) {
      add('clipLow', 'bad', ...fixVia(exp, nudge(exp, 0.15)));
    } else if (low >= CLIP_WARN) {
      add('clipLow', 'warn', ...fixVia(exp, nudge(exp, 0.08)));
    } else {
      add('exposureLevel', 'ok');
    }
  }

  // ── noise vs blur ─────────────────────────────────────────────────────────
  const gain = c.gain;
  const gf = frac(gain);
  if (gf != null) {
    if (gf >= GAIN_BAD) add('gainHigh', 'bad', { control: gain.id, value: nudge(gain, -0.3) });
    else if (gf >= GAIN_WARN) add('gainHigh', 'warn', { control: gain.id, value: nudge(gain, -0.15) });
    else add('gainHigh', 'ok');
  }

  if (exp && !exp.inactive && exp.value != null) {
    const ms = exp.value * EXPOSURE_UNIT_MS;
    // Guard against a driver that reuses the control name with other units:
    // an "exposure" of hours is not a reading worth advising on.
    if (ms > 0 && ms < 10000) {
      if (ms > BLUR_MS * 2) add('motionBlur', 'bad');
      else if (ms > BLUR_MS) add('motionBlur', 'warn');
    }
  }

  // ── flicker ───────────────────────────────────────────────────────────────
  const plf = c.power_line_frequency;
  if (plf && Array.isArray(plf.menu) && plf.menu.length) {
    const want = plf.menu.find(m => String(m.label).replace(/\s/g, '').startsWith(String(powerLineHz)));
    if (want && plf.value !== want.value) {
      add('powerLine', 'warn', { control: plf.id, value: want.value });
    }
  }

  return out;
}

// Split into what needs doing and what is already fine, so a panel can lead with
// the problems and keep the passing checks as quiet reassurance.
export function splitAdvice(items) {
  const rank = { bad: 0, warn: 1, ok: 2 };
  const sorted = [...(items || [])].sort((a, b) => rank[a.level] - rank[b.level]);
  return {
    problems: sorted.filter(i => i.level !== 'ok'),
    passing: sorted.filter(i => i.level === 'ok'),
    worst: sorted.length ? sorted[0].level : 'ok',
  };
}

// Where the current sharpness sits relative to the best seen this session.
// Focus is hunted by peak, not by absolute value — the number means nothing
// across scenes, but "you are at 62% of the best you have found" tells you
// whether to keep turning and which way you came from.
export function focusHint(current, peak) {
  if (!Number.isFinite(current) || !Number.isFinite(peak) || peak <= 0) return null;
  const ratio = Math.min(1, current / peak);
  return {
    ratio,
    level: ratio >= 0.95 ? 'ok' : ratio >= 0.7 ? 'warn' : 'bad',
  };
}
