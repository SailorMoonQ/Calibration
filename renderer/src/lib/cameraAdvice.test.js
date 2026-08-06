import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCamera, focusHint, splitAdvice } from './cameraAdvice.js';

const ctrl = (id, over = {}) => ({
  id, type: 'int', min: 0, max: 100, step: 1, value: 50, inactive: false, ...over,
});
const menu = (id, value, options) => ({
  id, type: 'menu', min: 0, max: 9, step: 1, value, inactive: false, menu: options,
});
const AE = (value) => menu('auto_exposure', value, [
  { value: 1, label: 'Manual Mode' }, { value: 3, label: 'Aperture Priority Mode' },
]);
const clean = { high: 0, low: 0 };

const find = (items, id) => items.find(i => i.id === id);
const levels = (items) => Object.fromEntries(items.map(i => [i.id, i.level]));

// ── stability ───────────────────────────────────────────────────────────────

test('auto exposure left on is a blocking problem', () => {
  const a = assessCamera({ controls: [AE(3)], stats: clean });
  const item = find(a, 'autoExposure');
  assert.equal(item.level, 'bad');
  // The fix must be concrete, not "go turn it off somewhere".
  assert.deepEqual(item.action, { control: 'auto_exposure', value: 1 });
});

test('auto exposure on manual passes', () => {
  assert.equal(find(assessCamera({ controls: [AE(1)], stats: clean }), 'autoExposure').level, 'ok');
});

test('the legacy exposure_auto spelling is handled too', () => {
  const legacy = menu('exposure_auto', 3, [{ value: 1, label: 'Manual Mode' }]);
  assert.equal(find(assessCamera({ controls: [legacy], stats: clean }), 'autoExposure').level, 'bad');
});

test('continuous autofocus is a blocking problem', () => {
  const af = ctrl('focus_automatic_continuous', { type: 'bool', min: 0, max: 1, value: 1 });
  const item = find(assessCamera({ controls: [af], stats: clean }), 'autoFocus');
  assert.equal(item.level, 'bad');
  assert.deepEqual(item.action, { control: 'focus_automatic_continuous', value: 0 });
});

// White balance is judged by the picture, not by the switch. Locking it used to
// be recommended unconditionally, which on the test rig produced a heavily green
// frame: the temperature control only trades red against blue, so the green a
// driver's auto mode was correcting comes back and cannot be dialled out.

const AWB = (value) => ctrl('white_balance_automatic', { type: 'bool', min: 0, max: 1, value });
const neutral = { ...clean, color: { cast: 0.02, channel: 'green', high: true } };
const green = { ...clean, color: { cast: 0.12, channel: 'green', high: true } };

test('automatic white balance producing a neutral picture is fine', () => {
  const item = find(assessCamera({ controls: [AWB(1)], stats: neutral }), 'whiteBalance');
  assert.equal(item.level, 'ok');
});

test('a locked white balance producing a neutral picture is fine', () => {
  // The ideal state: frozen AND correct. Nothing to say.
  const item = find(assessCamera({ controls: [AWB(0)], stats: neutral }), 'whiteBalance');
  assert.equal(item.level, 'ok');
});

test('a locked white balance producing a cast is a problem, and the fix unlocks it', () => {
  const item = find(assessCamera({ controls: [AWB(0)], stats: green }), 'colorCast');
  assert.equal(item.level, 'bad');
  assert.deepEqual(item.action, { control: 'white_balance_automatic', value: 1 });
});

test('a cast under automatic white balance gets no button it cannot honour', () => {
  // The driver is already doing its best; there is no tint control in UVC, so a
  // fix button here would do nothing.
  const item = find(assessCamera({ controls: [AWB(1)], stats: green }), 'colorCastAuto');
  assert.equal(item.level, 'warn');
  assert.equal(item.action, undefined);
});

test('white balance is not judged at all without a colour measurement', () => {
  const a = assessCamera({ controls: [AWB(0)], stats: clean });
  assert.equal(find(a, 'colorCast'), undefined);
  assert.equal(find(a, 'whiteBalance'), undefined);
});

test('a camera exposing none of these controls raises nothing about them', () => {
  const a = assessCamera({ controls: [ctrl('contrast')], stats: clean });
  assert.equal(find(a, 'autoExposure'), undefined);
  assert.equal(find(a, 'autoFocus'), undefined);
});

// ── exposure level ──────────────────────────────────────────────────────────

test('blown highlights are flagged and the fix shortens exposure', () => {
  const exp = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 5000 });
  const item = find(assessCamera({ controls: [exp], stats: { high: 0.2, low: 0 } }), 'clipHigh');
  assert.equal(item.level, 'bad');
  assert.equal(item.action.control, 'exposure_time_absolute');
  assert.ok(item.action.value < 5000, 'must reduce exposure, not raise it');
});

test('crushed shadows are flagged and the fix lengthens exposure', () => {
  const exp = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 100 });
  const item = find(assessCamera({ controls: [exp], stats: { high: 0, low: 0.2 } }), 'clipLow');
  assert.equal(item.level, 'bad');
  assert.ok(item.action.value > 100, 'must raise exposure, not cut it');
});

test('mild clipping warns rather than blocks', () => {
  const exp = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 1000 });
  assert.equal(find(assessCamera({ controls: [exp], stats: { high: 0.05, low: 0 } }), 'clipHigh').level, 'warn');
});

test('a few percent of clipping is normal for a chessboard and passes', () => {
  const a = assessCamera({ controls: [], stats: { high: 0.01, low: 0.01 } });
  assert.equal(find(a, 'exposureLevel').level, 'ok');
  assert.equal(find(a, 'clipHigh'), undefined);
});

test('highlights take priority over shadows when both clip', () => {
  // Recovering blown whites is impossible; lifted blacks still carry signal.
  const a = assessCamera({ controls: [], stats: { high: 0.2, low: 0.2 } });
  assert.ok(find(a, 'clipHigh'));
  assert.equal(find(a, 'clipLow'), undefined);
});

test('no exposure control means advice without an action, not a crash', () => {
  const item = find(assessCamera({ controls: [], stats: { high: 0.2, low: 0 } }), 'clipHigh');
  assert.equal(item.level, 'bad');
  assert.equal(item.action, undefined);
});

test('a locked exposure control yields no action button', () => {
  // Offering a fix that the driver will silently ignore is worse than none.
  const exp = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 5000, inactive: true });
  assert.equal(find(assessCamera({ controls: [exp], stats: { high: 0.2, low: 0 } }), 'clipHigh').action, undefined);
});

test('the suggested exposure never leaves the control range', () => {
  const atMin = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 50 });
  const item = find(assessCamera({ controls: [atMin], stats: { high: 0.2, low: 0 } }), 'clipHigh');
  assert.ok(item.action.value >= 50);
  const atMax = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 10000 });
  const it2 = find(assessCamera({ controls: [atMax], stats: { high: 0, low: 0.2 } }), 'clipLow');
  assert.ok(it2.action.value <= 10000);
});

test('the suggested value respects a non-unit step', () => {
  const exp = ctrl('exposure_time_absolute', { min: 100, max: 1000, step: 50, value: 500 });
  const item = find(assessCamera({ controls: [exp], stats: { high: 0.2, low: 0 } }), 'clipHigh');
  assert.equal((item.action.value - 100) % 50, 0);
});

// ── noise vs blur ───────────────────────────────────────────────────────────

// Gain and exposure are a coupled pair. Dropping gain alone just darkens the
// picture, and a dark board loses its black squares — worse than the noise it
// was meant to fix. These tests pin that the advice never does that.

const EXP = (over = {}) => ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 110, ...over });

test('lowering gain is ALWAYS paired with raising exposure', () => {
  const g = ctrl('gain', { min: 0, max: 128, value: 120 });
  const item = find(assessCamera({ controls: [g, EXP()], stats: clean }), 'gainHigh');
  assert.equal(item.level, 'bad');
  const sets = item.action.sets;
  assert.equal(sets.length, 2);
  const gs = sets.find(s => s.control === 'gain');
  const es = sets.find(s => s.control === 'exposure_time_absolute');
  assert.ok(gs.value < 120, 'gain must come down');
  assert.ok(es.value > 110, 'exposure must come up to hold brightness');
});

test('exposure is written before gain, so the transient is bright not black', () => {
  const g = ctrl('gain', { min: 0, max: 128, value: 120 });
  const sets = find(assessCamera({ controls: [g, EXP()], stats: clean }), 'gainHigh').action.sets;
  assert.equal(sets[0].control, 'exposure_time_absolute');
  assert.equal(sets[1].control, 'gain');
});

test('the paired exposure never crosses the motion-blur limit', () => {
  // BLUR_MS is 16 ms and the unit is 100 µs, so 160 is the ceiling.
  const g = ctrl('gain', { min: 0, max: 128, value: 128 });
  const sets = find(assessCamera({ controls: [g, EXP({ value: 140 })], stats: clean }), 'gainHigh').action.sets;
  const es = sets.find(s => s.control === 'exposure_time_absolute');
  assert.ok(es.value <= 160, `exposure ${es.value} would blur a handheld board`);
});

test('the gain cut is scaled back to what the exposure can absorb', () => {
  // Exposure nearly at the blur limit can only add a little, so gain may only
  // fall a little — cutting it further would darken the picture.
  const g = ctrl('gain', { min: 0, max: 128, value: 128 });
  const tight = find(assessCamera({ controls: [g, EXP({ value: 150 })], stats: clean }), 'gainHigh');
  const roomy = find(assessCamera({ controls: [g, EXP({ value: 60 })], stats: clean }), 'gainHigh');
  const drop = (it) => 128 - it.action.sets.find(s => s.control === 'gain').value;
  assert.ok(drop(tight) < drop(roomy), `${drop(tight)} should be a smaller cut than ${drop(roomy)}`);
});

test('no exposure headroom means no gain fix at all, and a different message', () => {
  // At the blur limit there is nothing to trade. Telling the user to cut gain
  // here would darken the picture for no benefit; what they need is more light.
  const g = ctrl('gain', { min: 0, max: 128, value: 120 });
  const a = assessCamera({ controls: [g, EXP({ value: 200 })], stats: clean });
  assert.equal(find(a, 'gainHigh'), undefined);
  assert.equal(find(a, 'gainNeedsLight').level, 'bad');
});

test('a locked exposure blocks the gain fix rather than cutting gain alone', () => {
  const g = ctrl('gain', { min: 0, max: 128, value: 120 });
  const exp = EXP({ inactive: true, locked_by: { id: 'auto_exposure', unlock_value: 1 } });
  const item = find(assessCamera({ controls: [g, exp], stats: clean }), 'gainHigh');
  assert.equal(item.action, undefined);
  assert.equal(item.blockedBy, 'auto_exposure');
});

test('with no exposure control at all, gain is never cut on its own', () => {
  const g = ctrl('gain', { min: 0, max: 128, value: 120 });
  const a = assessCamera({ controls: [g], stats: clean });
  assert.equal(find(a, 'gainHigh'), undefined);
  assert.equal(find(a, 'gainNeedsLight').level, 'bad');
});

test('moderate gain warns, low gain passes', () => {
  assert.equal(find(assessCamera({ controls: [ctrl('gain', { min: 0, max: 128, value: 70 }), EXP()], stats: clean }), 'gainHigh').level, 'warn');
  assert.equal(find(assessCamera({ controls: [ctrl('gain', { min: 0, max: 128, value: 20 }), EXP()], stats: clean }), 'gainHigh').level, 'ok');
});

test('the paired values stay inside both controls ranges and step grids', () => {
  const g = ctrl('gain', { min: 0, max: 128, step: 4, value: 120 });
  const e = ctrl('exposure_time_absolute', { min: 50, max: 10000, step: 10, value: 100 });
  const sets = find(assessCamera({ controls: [g, e], stats: clean }), 'gainHigh').action.sets;
  const gs = sets.find(s => s.control === 'gain');
  const es = sets.find(s => s.control === 'exposure_time_absolute');
  assert.equal(gs.value % 4, 0);
  assert.ok(gs.value >= 0 && gs.value <= 128);
  assert.equal((es.value - 50) % 10, 0);
  assert.ok(es.value >= 50 && es.value <= 10000);
});

test('a long exposure warns about motion blur', () => {
  // exposure_time_absolute is in 100 µs units: 400 = 40 ms.
  const exp = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 400 });
  assert.equal(find(assessCamera({ controls: [exp], stats: clean }), 'motionBlur').level, 'bad');
});

test('a short exposure raises no blur concern', () => {
  const exp = ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 100 });  // 10 ms
  assert.equal(find(assessCamera({ controls: [exp], stats: clean }), 'motionBlur'), undefined);
});

test('an implausible exposure reading is ignored rather than advised on', () => {
  // A driver reusing the control name with other units must not produce
  // confident nonsense.
  const exp = ctrl('exposure_time_absolute', { min: 0, max: 2 ** 31, value: 2 ** 30 });
  assert.equal(find(assessCamera({ controls: [exp], stats: clean }), 'motionBlur'), undefined);
});

// ── flicker ─────────────────────────────────────────────────────────────────

test('a mains-frequency mismatch is flagged with the right target', () => {
  const plf = menu('power_line_frequency', 2, [
    { value: 0, label: 'Disabled' }, { value: 1, label: '50 Hz' }, { value: 2, label: '60 Hz' },
  ]);
  const item = find(assessCamera({ controls: [plf], stats: clean, powerLineHz: 50 }), 'powerLine');
  assert.deepEqual(item.action, { control: 'power_line_frequency', value: 1 });
});

test('a matching mains frequency says nothing', () => {
  const plf = menu('power_line_frequency', 1, [
    { value: 0, label: 'Disabled' }, { value: 1, label: '50 Hz' }, { value: 2, label: '60 Hz' },
  ]);
  assert.equal(find(assessCamera({ controls: [plf], stats: clean, powerLineHz: 50 }), 'powerLine'), undefined);
});

test('a menu without the wanted frequency is left alone', () => {
  const plf = menu('power_line_frequency', 0, [{ value: 0, label: 'Disabled' }]);
  assert.equal(find(assessCamera({ controls: [plf], stats: clean, powerLineHz: 50 }), 'powerLine'), undefined);
});

// ── shape of the result ─────────────────────────────────────────────────────

test('assessCamera on nothing at all returns an empty list', () => {
  assert.deepEqual(assessCamera(), []);
  assert.deepEqual(assessCamera({ controls: [], stats: null }), []);
});

test('splitAdvice puts problems first, worst first', () => {
  const items = [
    { id: 'a', level: 'ok' }, { id: 'b', level: 'warn' }, { id: 'c', level: 'bad' },
  ];
  const s = splitAdvice(items);
  assert.deepEqual(s.problems.map(i => i.id), ['c', 'b']);
  assert.deepEqual(s.passing.map(i => i.id), ['a']);
  assert.equal(s.worst, 'bad');
});

test('splitAdvice on an all-clear list reports ok', () => {
  const s = splitAdvice([{ id: 'a', level: 'ok' }]);
  assert.equal(s.worst, 'ok');
  assert.deepEqual(s.problems, []);
});

test('splitAdvice tolerates nothing', () => {
  assert.equal(splitAdvice().worst, 'ok');
});

test('a fully configured camera reports every check green', () => {
  const controls = [
    AE(1),
    ctrl('exposure_time_absolute', { min: 50, max: 10000, value: 120 }),
    ctrl('gain', { min: 0, max: 128, value: 20 }),
    ctrl('focus_automatic_continuous', { type: 'bool', min: 0, max: 1, value: 0 }),
    menu('power_line_frequency', 1, [{ value: 1, label: '50 Hz' }]),
  ];
  const s = splitAdvice(assessCamera({ controls, stats: { high: 0.005, low: 0.005 } }));
  assert.deepEqual(s.problems, [], JSON.stringify(s.problems));
  assert.equal(s.worst, 'ok');
  assert.deepEqual(levels(s.passing), {
    autoExposure: 'ok', autoFocus: 'ok', exposureLevel: 'ok', gainHigh: 'ok',
  });
});

// ── focus peak ──────────────────────────────────────────────────────────────

test('focusHint reports position relative to the best seen', () => {
  assert.equal(focusHint(100, 100).level, 'ok');
  assert.equal(focusHint(80, 100).level, 'warn');
  assert.equal(focusHint(30, 100).level, 'bad');
  assert.ok(Math.abs(focusHint(50, 100).ratio - 0.5) < 1e-9);
});

test('focusHint caps at 1 when the current reading is the new peak', () => {
  assert.equal(focusHint(150, 100).ratio, 1);
});

test('focusHint refuses to guess without a peak', () => {
  assert.equal(focusHint(50, 0), null);
  assert.equal(focusHint(NaN, 100), null);
  assert.equal(focusHint(50, NaN), null);
});

// ── blocked fixes ───────────────────────────────────────────────────────────

test('a locked exposure reports WHICH control is holding the lock', () => {
  // A button that writes an inactive control looks like it worked and changes
  // nothing, so we withhold it — but silence would just be puzzling.
  const exp = ctrl('exposure_time_absolute', {
    min: 50, max: 10000, value: 5000, inactive: true,
    locked_by: { id: 'auto_exposure', unlock_value: 1 },
  });
  const item = find(assessCamera({ controls: [exp], stats: { high: 0.2, low: 0 } }), 'clipHigh');
  assert.equal(item.action, undefined);
  assert.equal(item.blockedBy, 'auto_exposure');
});

test('an absent exposure control blocks on nothing in particular', () => {
  const item = find(assessCamera({ controls: [], stats: { high: 0.2, low: 0 } }), 'clipHigh');
  assert.equal(item.action, undefined);
  assert.equal(item.blockedBy, undefined);
});

test('the prerequisite is listed before the check it blocks', () => {
  // Fixing auto-exposure is what unlocks the exposure fix, so it must not be
  // buried below it.
  const controls = [
    AE(3),
    ctrl('exposure_time_absolute', {
      min: 50, max: 10000, value: 5000, inactive: true,
      locked_by: { id: 'auto_exposure', unlock_value: 1 },
    }),
  ];
  const { problems } = splitAdvice(assessCamera({ controls, stats: { high: 0.2, low: 0 } }));
  const ids = problems.map(p => p.id);
  assert.ok(ids.indexOf('autoExposure') < ids.indexOf('clipHigh'), ids.join(','));
});
