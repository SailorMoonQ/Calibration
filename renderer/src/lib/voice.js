// Voice I/O for the calibration capture loop — Chinese only, entirely optional,
// gated by the ⚙ settings:
//   • Voice PROMPTS  — pre-synthesised (Microsoft Edge neural TTS) spoken cues
//     played at capture/solve moments and as directional guidance ("向左一点").
//     Bundled as static audio, so they work offline once installed.
//   • Voice COMMANDS — hands-free control via the browser SpeechRecognition API
//     (Chromium's built-in engine; needs network). Recognises a few keywords.
//
// Neither path touches the calibration solver.

import captured from '../assets/voice/zh/captured.mp3';
import allCovered from '../assets/voice/zh/allCovered.mp3';
import solveStart from '../assets/voice/zh/solveStart.mp3';
import solveOk from '../assets/voice/zh/solveOk.mp3';
import solveFail from '../assets/voice/zh/solveFail.mp3';
import tiltHint from '../assets/voice/zh/tiltHint.mp3';
import listening from '../assets/voice/zh/listening.mp3';
import moveLeft from '../assets/voice/zh/moveLeft.mp3';
import moveRight from '../assets/voice/zh/moveRight.mp3';
import moveUp from '../assets/voice/zh/moveUp.mp3';
import moveDown from '../assets/voice/zh/moveDown.mp3';
import moveOut from '../assets/voice/zh/moveOut.mp3';
import onTarget from '../assets/voice/zh/onTarget.mp3';

const CLIPS = {
  captured, allCovered, solveStart, solveOk, solveFail, tiltHint, listening,
  moveLeft, moveRight, moveUp, moveDown, moveOut, onTarget,
};

// One shared <audio> element; prompts are short and shouldn't overlap, so a new
// prompt cuts off the previous one rather than stacking. Rate-limiting is the
// caller's job.
let audioEl = null;
export function speak(name) {
  const src = CLIPS[name];
  if (!src) return;
  try {
    if (!audioEl) audioEl = new Audio();
    audioEl.src = src;
    audioEl.currentTime = 0;
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => { /* autoplay/permission — ignore */ });
  } catch { /* ignore */ }
}

// Keyword → action map (Chinese). Matched as substrings against the transcript
// so "拍一下照" still fires "拍照".
const KEYWORDS = [
  { action: 'snap',  words: ['拍照', '拍照片', '采集', '抓拍', '拍一张', '拍'] },
  { action: 'solve', words: ['标定', '开始标定', '计算'] },
  { action: 'undo',  words: ['撤销', '撤回'] },
  { action: 'drop',  words: ['删除', '删掉', '丢弃'] },
];

export function voiceSupported() {
  return typeof window !== 'undefined'
    && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Build a keyword recognizer. Returns { start, stop, supported }. `onCommand` is
// called with an action string ('snap' | 'solve' | 'undo' | 'drop'). `onState`
// reports lifecycle ('listening' | 'stopped' | 'error:<reason>') for the UI.
export function createVoiceRecognizer({ onCommand, onState } = {}) {
  const Ctor = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!Ctor) return { start() {}, stop() {}, supported: false };

  let rec = null;
  let running = false;
  let stopping = false;
  let lastFire = 0;

  const match = (text) => {
    const s = text.toLowerCase();
    for (const { action, words } of KEYWORDS) {
      if (words.some(w => s.includes(w))) return action;
    }
    return null;
  };

  const build = () => {
    const r = new Ctor();
    r.lang = 'zh-CN';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const txt = ev.results[i][0]?.transcript || '';
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
      if (running && !stopping) { try { r.start(); } catch { /* retry on next end */ } }
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
