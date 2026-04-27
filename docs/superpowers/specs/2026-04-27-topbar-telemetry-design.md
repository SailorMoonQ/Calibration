# Topbar telemetry — design

Replaces the three hardcoded pills in `renderer/src/components/Topbar.jsx:10-12`
(`cam0 30.1 fps`, `SteamVR · 2 bases`, `tracker·3 drop 0.2%`) with live status
driven by the streams that the active tab is already running.

## Goals

- Topbar pills reflect real sensor activity, not mock strings.
- No new background subscriptions: pills only show data the active tab has
  already opened. When no tab is reading from a sensor, its pill is absent.
- Wiring is cheap to add to other tabs later.

## Architecture (B1 — React context)

```
                       <TelemetryProvider>
                       /        |          \
            useReportCamera   useReportPoses   useTelemetry
                  ▲                ▲                ▲
                  │                │                │
       LivePreview / LiveDetected  LinkCalibTab     Topbar
       (per-camera FPS)            (pose stream)    (renders pills)
```

State held by the provider:

```ts
cameras: Map<device, { fps: number, target: number, ts: number }>
poses:   { source: string[], bases: number,
           perDevice: Map<name, { dropPct: number, ts: number }> } | null
```

Hooks:

- `useReportCamera(device, fps, target)` — call inside a preview component;
  cleanup on unmount removes the device entry.
- `useReportPoses(stats | null)` — same idea for the pose consumer; passing
  `null` clears all pose pills.
- `useTelemetry()` — read-only snapshot consumed by the Topbar.

Throttling: the writer hooks coalesce updates to ~2 Hz internally so
re-renders don't fire on every frame.

## Backend change — SteamVR base count

`backend/app/sources/poses/steamvr.py` currently strips `tracking_reference`
entries from the device list (correct: base stations don't move). It also
discards their *count*, which the Topbar needs.

- Keep filtering them out of the tracked device list.
- Count them and add `"bases": <int>` to `hello()`.
- `mock.py` and `oculus.py` set `"bases": 0` so the field is always present.
- The `/poses/stream` route's hello-merge picks the max `bases` across
  sources (only steamvr will set non-zero).

## Renderer integration

### Camera FPS pills

`LivePreview.jsx` and `LiveDetectedFrame.jsx` already compute
`capFps`/`fps` (target). Add one line in each:

```js
useReportCamera(device, capFps, fps);
```

The Topbar renders one pill per entry in `cameras`, ordered by device name.
Label: `cam0 30.1 fps` (basename of `/dev/videoN` → `camN`; opaque names
fall through verbatim). Status:

- `ok` if `fps >= 0.85 × target`
- `warn` if `fps >= 0.5 × target`
- `bad` if `fps == 0`, `fps < 0.5 × target`, or `ts` is stale > 2 s

### Pose pills

In `LinkCalibTab.jsx`'s existing `ws.onmessage`:

- On `hello`: capture `m.devices` (expected set), `m.bases`, `m.sources`.
  Initialize a per-device 5 s ring buffer of `{ts, present}` ticks.
- On `sample`: for every expected device push `{ts, present: dev in m.poses}`;
  trim entries older than 5 s.
- A 500 ms interval recomputes per-device `dropPct = absent / total × 100`
  and calls `useReportPoses({ source, bases, perDevice })`.
- On WS close or component unmount: call `useReportPoses(null)`.

Topbar renders, in this order:

1. SteamVR pill iff `poses.source` includes `'steamvr'`.
   Label `SteamVR · N bases`. Status: `ok` if `N ≥ 2`, `warn` if `N == 1`,
   `bad` if `N == 0` (SteamVR up but no base station visible).
2. One pill per device in `poses.perDevice`, alphabetical. Label
   `<name> drop X.X%`. Status: `ok < 1%`, `warn 1–5%`, `bad > 5%`.

Controllers and HMDs are included alongside trackers — anything that
SteamVR reports as a tracked device gets a pill.

### Empty state

If both `cameras` and `poses` are empty/null, the `.session` div renders no
pills and collapses. The two surrounding `<span class="divider"/>` stay so
the topbar geometry doesn't shift.

## Files touched

| File | Change |
| --- | --- |
| `backend/app/sources/poses/steamvr.py` | Add `bases` to `hello()` |
| `backend/app/sources/poses/mock.py` | Add `bases: 0` to `hello()` |
| `backend/app/sources/poses/oculus.py` | Add `bases: 0` to `hello()` |
| `backend/app/api/routes.py` | Forward `bases` in merged hello envelope |
| `renderer/src/lib/telemetry.jsx` | New: provider + hooks |
| `renderer/src/App.jsx` | Wrap children with `<TelemetryProvider>` |
| `renderer/src/components/Topbar.jsx` | Read context, render pills dynamically |
| `renderer/src/components/LivePreview.jsx` | Call `useReportCamera` |
| `renderer/src/components/LiveDetectedFrame.jsx` | Call `useReportCamera` |
| `renderer/src/tabs/LinkCalibTab.jsx` | Track per-device drop, call `useReportPoses` |

## Edges and reliability

- **Stale entries.** A 1 Hz interval inside the provider drops entries older
  than 3 s. Backstop for cases where a writer fails to clean up (tab
  unmounted via error, WS dropped without `close` event).
- **Reordering.** Stable alphabetical sort within each pill group prevents
  layout jitter as values update.
- **WS reconnect.** On reconnect, a fresh `hello` resets the per-device
  rings; old drop% data is discarded.

## Manual test plan

No automated tests exist for the topbar layer; verification is manual.

1. Open Intrinsics → one camera pill, FPS updates live.
2. Switch to Extrinsics → two camera pills (`cam0`, `cam1`).
3. Switch to Link with `sources=mock` → no SteamVR pill; one drop pill per
   mock device.
4. Switch to Link with `sources=steamvr` → `SteamVR · N bases` pill plus
   per-device drop pills (trackers/controllers/HMD).
5. Stop a stream → matching pills disappear within ~1 s.
6. Kill SteamVR mid-stream → drop% climbs, status flips to `bad`.

## Out of scope

- Per-pill click-through to a details view.
- Persisting telemetry across tab switches when no consumer is mounted.
- `renderer/src/lib/mock.js` (used by tab views for reprojection-residual
  visualizations, unrelated to topbar pills).
