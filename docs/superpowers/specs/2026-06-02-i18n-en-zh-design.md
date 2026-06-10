# i18n (English + Chinese) — Design

**Date:** 2026-06-02
**Status:** Approved (brainstorm), pending implementation plan
**Scope:** Internationalize the entire React renderer with English and Chinese (Simplified). Backend stays English.

## Goal

Let a user switch the whole UI between **English** and **简体中文** at runtime via a Topbar toggle. The choice persists; on first launch the app follows the system locale. No feature behavior changes — only the language of displayed text.

## Decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| Translation layer | `react-i18next` + `i18next` |
| Backend-originated strings | **English passthrough** — solver/error `.message` text is only ever an interpolation *parameter*, never a translation key |
| Language toggle location | **Topbar**, next to the ⚙ settings button |
| First-launch default | **Follow system locale** (`navigator.language` → `zh` if `zh-*`, else `en`), persists once changed |
| Chinese terminology | Translate common technical terms (内参 / 校正 / 手眼标定…); keep established acronyms & proper nouns in English (ChArUco, SteamVR, PICO, ROS2, YAML) |

## Architecture

### Library & wiring
- Add `i18next` and `react-i18next` to the root `package.json` dependencies.
- New folder `renderer/src/i18n/`:
  - `index.js` — initializes the global i18next instance:
    - `fallbackLng: 'en'`
    - `supportedLngs: ['en', 'zh']`
    - `interpolation: { escapeValue: false }`
    - `lng` resolved by the initial-language logic below
    - `resources: { en: { translation: en }, zh: { translation: zh } }`
  - `en.json`, `zh.json` — translation catalogs.
- `main.jsx` imports `./i18n` **before** rendering `<App />`, so the global instance is initialized first. Components consume it through the `useTranslation()` hook; no `<I18nextProvider>` wrapper is required when using the default instance.

### Catalog structure
Single `translation` namespace, organized by area with dotted keys:

```
common.*      shared words/units reused across tabs (snap, drop, run, reset, ready…)
topbar.*      brand, settings tooltip, language labels
tabs.*        per-tab label + sub (tabs.intrinsics.label, tabs.intrinsics.sub, …)
tweaks.*      settings panel (theme, density, accent hue, reset)
panels.*      shared panels (FrameStrip, CaptureControls, SolverButton, SourcePanel, TargetPanel, …)
intrinsics.*  Pinhole tab strings + status messages
fisheye.*     Fish-eye tab strings + status messages
handeye.*     Hand-Eye tab strings + status messages
link.*        Link tab strings + status messages
```

### Initial language + persistence
- Startup resolution (in `i18n/index.js`):
  `localStorage.getItem('calib_lang')` if present, else `navigator.language?.startsWith('zh') ? 'zh' : 'en'`.
- A `setLang(lng)` helper:
  1. `i18n.changeLanguage(lng)`
  2. `localStorage.setItem('calib_lang', lng)`
  3. `document.documentElement.setAttribute('lang', lng)`
- No `i18next-browser-languagedetector` dependency — the one-line check above is sufficient for two languages.

### Language toggle (Topbar)
- A compact **EN / 中** two-option segmented control beside the existing ⚙ button (`Topbar.jsx:69`), reusing existing button / `Seg` styling.
- Reads `i18n.language`; clicking an option calls `setLang`.

## String-handling rules

- Every user-facing literal becomes `t('area.key')`.
- Interpolated strings pass params; the dynamic value (including backend text) is the parameter:
  - `t('intrinsics.snapFailed', { error: e.message })` → EN `"snap failed: {{error}}"`, ZH `"抓取失败：{{error}}"`.
  - `t('panels.autoRate', { rate: rate.toFixed(1), fps: fps.toFixed(1) })` → `"auto rate · {{rate}}s (≈{{fps}} fps)"`.
- Counts use i18next plural support where natural (e.g. `dataset.count`), with Chinese providing a single form.
- Module-level `TAB_DEFS` keeps static `id`/`num`; `label`/`sub` resolve at render via `t('tabs.<id>.label')` / `t('tabs.<id>.sub')`.
- Left literal: units & symbols (`px`, `fps`, `s`, `k₁ k₂ p₁ p₂ k₃…`, keyboard glyphs like `⌘↵`), file paths, device names, proper nouns/acronyms (ChArUco, SteamVR, PICO, ROS2, YAML).
- Brand name "Calibration Workbench" becomes a key, identical text in both languages for now.

## Files touched (~20)
`main.jsx`, `App.jsx`, `Topbar.jsx`, `Tabs.jsx`, `TweaksPanel.jsx`, `components/panels.jsx`, `components/CameraSource.jsx`, `tabs/IntrinsicsTab.jsx`, `tabs/FisheyeTab.jsx`, `tabs/HandEyeTab.jsx`, `tabs/LinkCalibTab.jsx`, plus smaller components carrying stray strings, and the new `i18n/` files.

## Implementation phasing
Too large for one blind pass (~250–300 strings). Phased so each phase ends with a clean build:
- **A.** Infra: deps, `i18n/index.js`, `en.json`/`zh.json` skeleton, `main.jsx` import, Topbar toggle, initial-language detection + persistence.
- **B.** Shared components: `Topbar`, `Tabs`, `TweaksPanel`, `panels.jsx`, `CameraSource`, App-level tab defs.
- **C–F.** One tab at a time: Intrinsics → Fisheye → Hand-Eye → Link, each including its status/error messages.

## Verification
- `npm run build:renderer` compiles clean after every phase.
- New `scripts/check-i18n-keys.mjs`: asserts `en.json` and `zh.json` have **identical key sets** (no test runner exists in the repo; this is the guardrail against missing/typo'd keys). Run during verification.
- Manual spot-check of both languages across all 4 tabs + the settings panel + the Topbar toggle.

## Out of scope
- Backend (Python) message translation.
- Languages other than English and Simplified Chinese.
- Right-to-left layout, number/date localization.
