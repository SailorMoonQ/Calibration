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

// How far a channel may sit from the average of the three, in the highlights,
// before the picture counts as tinted. Measured on the rig: a correctly balanced
// frame reads 0.02, and the green cast a locked white balance produced read
// 0.12. Set between them, nearer the good end — a visible tint is already
// costing range in the other two channels.
const CAST_BAD = 0.06;

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

// Trade gain for exposure at roughly constant brightness.
//
// Returns the paired writes, or null when exposure cannot absorb any of it.
//
// The brightness model is deliberately crude: V4L2 does not define what a gain
// unit means — some drivers are linear in a multiplier, others in dB, others in
// a raw register — so an exact compensation is not computable. We assume
// brightness scales with (value - min) offset by one unit, take a MODEST step,
// and let the user click again. Being off by a factor then costs a slightly
// wrong brightness that the clipping checks immediately report, rather than a
// confident jump to the wrong place.
function tradeGainForExposure(gain, exp, wantDrop) {
  if (!gain || !exp || exp.inactive || exp.value == null) return null;
  const span = gain.max - gain.min;
  if (!span) return null;

  // Treat gain as a multiplier proportional to (value - min + 1) so that the
  // bottom of the range is unity rather than zero brightness.
  const g0 = gain.value - gain.min + 1;
  const headroomMs = Math.max(0, BLUR_MS - exp.value * EXPOSURE_UNIT_MS);
  if (headroomMs <= 0) return null;   // already at the blur limit

  // Largest exposure we are willing to reach, bounded by blur and by the control.
  const expMax = Math.min(exp.max, Math.round(BLUR_MS / EXPOSURE_UNIT_MS));
  if (expMax <= exp.value) return null;

  // How much brightness the exposure can add, and therefore how much gain we can
  // afford to give up.
  const expRatioMax = expMax / exp.value;
  const wantedRatio = g0 / Math.max(1, g0 - wantDrop * span);
  const ratio = Math.min(wantedRatio, expRatioMax);
  if (ratio <= 1.02) return null;     // not worth a round trip

  const newGainRaw = gain.min + (g0 / ratio) - 1;
  const newGain = clampToStep(gain, newGainRaw);
  const newExp = clampToStep(exp, exp.value * ratio);
  if (newGain >= gain.value || newExp <= exp.value) return null;

  return {
    sets: [
      // Exposure first: a momentarily brighter frame is friendlier than a
      // momentarily black one if the user is watching the board.
      { control: exp.id, value: newExp },
      { control: gain.id, value: newGain },
    ],
  };
}

function clampToStep(c, raw) {
  const step = c.step || 1;
  let v = c.min + Math.round((raw - c.min) / step) * step;
  v = Math.max(c.min, Math.min(c.max, Math.round(v)));
  return v;
}

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

  // ── white balance ─────────────────────────────────────────────────────────
  //
  // This used to offer "lock the white balance" whenever it was automatic, on
  // the theory that nothing should re-decide itself between frames. That advice
  // was wrong, and produced a heavily green picture on the test rig: locking
  // freezes the colour TEMPERATURE control, which only trades red against blue.
  // The green/magenta axis has no UVC control at all, so whatever green the
  // driver's auto mode was correcting comes straight back and cannot be dialled
  // out. Measured on the rig, highlights that should be neutral: 2800 K gave
  // R156/G216/B194, 6500 K gave R189/G210/B135, and auto gave R198/G203/B204.
  //
  // So the rule is not "locked or automatic" but "neutral or not". Locking is
  // worth having only when what gets frozen is correct, and that is something
  // the picture can be asked about directly.
  const awb = c.white_balance_automatic;
  const cast = stats?.color;
  if (awb && cast) {
    if (cast.cast >= CAST_BAD && !awb.value) {
      // Locked onto a cast. Handing colour back to the driver is the only fix
      // available from here — the temperature control cannot reach this axis.
      add('colorCast', 'bad', ...fixVia(awb, 1));
    } else if (cast.cast >= CAST_BAD) {
      // Already automatic and still cast: unusual lighting, or the driver's auto
      // mode cannot cope. Nothing on this panel will fix it, so say so instead
      // of offering a button that does nothing.
      add('colorCastAuto', 'warn');
    } else {
      add('whiteBalance', 'ok');
    }
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
  // Gain and exposure are a COUPLED pair: both scale brightness, and the reason
  // to prefer exposure is that it adds signal while gain only amplifies what is
  // there, noise included. So the fix is never "turn the gain down" on its own —
  // that just makes the picture dark, and a dark board loses its black squares,
  // which is worse than a slightly noisy one. Every gain reduction here is
  // paired with the exposure rise that holds brightness, and is scaled back to
  // whatever that exposure can actually absorb.
  const gain = c.gain;
  const gf = frac(gain);
  if (gf != null) {
    if (gf >= GAIN_WARN) {
      const swap = tradeGainForExposure(gain, exp, gf >= GAIN_BAD ? 0.3 : 0.15);
      const level = gf >= GAIN_BAD ? 'bad' : 'warn';
      if (swap) {
        add('gainHigh', level, { sets: swap.sets });
      } else if (exp && exp.inactive) {
        add('gainHigh', level, null, exp.locked_by?.id || null);
      } else {
        // Exposure has nothing left to give: at this light level the gain is
        // doing necessary work, and cutting it would only darken the picture.
        // The real fix is more light, which no control can supply.
        add('gainNeedsLight', level);
      }
    } else {
      add('gainHigh', 'ok');
    }
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
