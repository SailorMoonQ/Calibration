// Voice I/O for the calibration capture loop — entirely optional, gated by the
// settings in the ⚙ menu:
//   • Voice PROMPTS  — pre-synthesised (Microsoft Edge neural TTS) spoken cues
//     played at capture/solve moments. Bundled as static audio, so they work
//     offline once installed.
//   • Voice COMMANDS — hands-free control via the browser SpeechRecognition API
//     (Chromium's built-in engine; needs network). Recognises a few keywords and
//     maps them to actions, so you can snap/solve without touching the keyboard.
//
// Neither path touches the calibration solver.

// Static prompt clips, per language. Vite fingerprints these and rewrites the
// URLs to respect the app's relative base, so they resolve in the packaged app.
import zhCaptured from '../assets/voice/zh/captured.mp3';
import zhAllCovered from '../assets/voice/zh/allCovered.mp3';
import zhSolveStart from '../assets/voice/zh/solveStart.mp3';
import zhSolveOk from '../assets/voice/zh/solveOk.mp3';
import zhSolveFail from '../assets/voice/zh/solveFail.mp3';
import zhTiltHint from '../assets/voice/zh/tiltHint.mp3';
import zhListening from '../assets/voice/zh/listening.mp3';
import enCaptured from '../assets/voice/en/captured.mp3';
import enAllCovered from '../assets/voice/en/allCovered.mp3';
import enSolveStart from '../assets/voice/en/solveStart.mp3';
import enSolveOk from '../assets/voice/en/solveOk.mp3';
import enSolveFail from '../assets/voice/en/solveFail.mp3';
import enTiltHint from '../assets/voice/en/tiltHint.mp3';
import enListening from '../assets/voice/en/listening.mp3';

const CLIPS = {
  'zh-CN': {
    captured: zhCaptured, allCovered: zhAllCovered, solveStart: zhSolveStart,
    solveOk: zhSolveOk, solveFail: zhSolveFail, tiltHint: zhTiltHint, listening: zhListening,
  },
  'en-US': {
    captured: enCaptured, allCovered: enAllCovered, solveStart: enSolveStart,
    solveOk: enSolveOk, solveFail: enSolveFail, tiltHint: enTiltHint, listening: enListening,
  },
};

// One shared <audio> element; prompts are short and shouldn't overlap, so a new
// prompt cuts off the previous one rather than stacking. Some clips (e.g. the
// per-snap "captured") are rate-limited by the caller, not here.
let audioEl = null;
export function speak(name, { lang = 'zh-CN' } = {}) {
  const set = CLIPS[lang] || CLIPS['zh-CN'];
  const src = set[name];
  if (!src) return;
  try {
    if (!audioEl) audioEl = new Audio();
    audioEl.src = src;
    audioEl.currentTime = 0;
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => { /* autoplay/permission — ignore */ });
  } catch { /* ignore */ }
}

// Keyword → action maps. Matched as substrings against the (lowercased)
// transcript so "拍照" fires on "拍一下照" too, and "calibrate it" → solve.
const KEYWORDS = {
  'zh-CN': [
    { action: 'snap',  words: ['拍照', '拍照片', '采集', '抓拍', '拍一张', '拍'] },
    { action: 'solve', words: ['标定', '开始标定', '计算'] },
    { action: 'undo',  words: ['撤销', '撤回'] },
    { action: 'drop',  words: ['删除', '删掉', '丢弃'] },
  ],
  'en-US': [
    { action: 'snap',  words: ['capture', 'snap', 'shoot', 'take'] },
    { action: 'solve', words: ['calibrate', 'solve', 'compute'] },
    { action: 'undo',  words: ['undo'] },
    { action: 'drop',  words: ['delete', 'drop', 'discard'] },
  ],
};

export function voiceSupported() {
  return typeof window !== 'undefined'
    && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Build a keyword recognizer. Returns { start, stop, supported }. `onCommand` is
// called with an action string ('snap' | 'solve' | 'undo' | 'drop'). `onState`
// reports lifecycle ('listening' | 'stopped' | 'error:<reason>') for the UI.
export function createVoiceRecognizer({ lang = 'zh-CN', onCommand, onState } = {}) {
  const Ctor = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!Ctor) return { start() {}, stop() {}, supported: false };

  const maps = KEYWORDS[lang] || KEYWORDS['zh-CN'];
  let rec = null;
  let running = false;
  let stopping = false;
  let lastFire = 0;

  const match = (text) => {
    const s = text.toLowerCase();
    for (const { action, words } of maps) {
      if (words.some(w => s.includes(w.toLowerCase()))) return action;
    }
    return null;
  };

  const build = () => {
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const txt = res[0]?.transcript || '';
        const action = match(txt);
        if (!action) continue;
        const now = Date.now();
        if (now - lastFire < 1200) return;   // debounce repeated/echoed phrases
        lastFire = now;
        try { onCommand?.(action); } catch { /* swallow */ }
        return;
      }
    };
    r.onerror = (e) => { onState?.(`error:${e.error || 'unknown'}`); };
    r.onend = () => {
      // Chromium ends continuous recognition periodically; restart unless asked to stop.
      if (running && !stopping) { try { r.start(); } catch { /* will retry on next end */ } }
      else onState?.('stopped');
    };
    return r;
  };

  return {
    supported: true,
    start() {
      if (running) return;
      running = true; stopping = false;
      rec = build();
      try { rec.start(); onState?.('listening'); }
      catch (e) { running = false; onState?.(`error:${e.message || 'start'}`); }
    },
    stop() {
      stopping = true; running = false;
      try { rec?.stop(); } catch { /* ignore */ }
      rec = null;
    },
  };
}
