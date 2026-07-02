from __future__ import annotations

import io
import ipaddress
import json
import os
import queue
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response, StreamingResponse


COMMAND_LABELS = {
    "calibrate": "标定",
    "photo": "拍照",
    "capture": "采集",
}


_ALIASES = {
    "calibrate": [
        "标定", "标订", "标顶", "表定", "表订", "表弟", "标题", "标点", "彪定", "飙定",
        "校准", "矫准", "较准", "求解", "运行标定", "开始标定",
        "calibrate", "calibration", "solve",
    ],
    "photo": [
        "拍照", "拍摄", "拍一张", "拍张照", "拍个照", "拍一下", "照相", "快照",
        "茄子", "咔嚓", "咔擦", "卡嚓", "卡擦", "咔咔", "cheese", "snap", "snapshot", "photo",
    ],
    "capture": [
        "采集", "采籍", "采辑", "彩集", "才集", "踩集", "采样", "收集",
        "开始采集", "采一张", "采一下", "取样", "记录", "capture", "collect", "acquire",
    ],
}

_FLAT_ALIASES: list[tuple[str, str]] = [
    (command, alias.lower().replace(" ", ""))
    for command, aliases in _ALIASES.items()
    for alias in aliases
]


def _normalize(text: str) -> str:
    return "".join(str(text or "").lower().split())


def match_command(text: str) -> tuple[str, str] | None:
    normalized = _normalize(text)
    if not normalized:
        return None

    best: tuple[int, int, str, str] | None = None
    for command, alias in _FLAT_ALIASES:
        idx = normalized.find(alias)
        if idx < 0:
            continue
        candidate = (idx, -len(alias), command, alias)
        if best is None or candidate < best:
            best = candidate
    if best:
        return best[2], COMMAND_LABELS[best[2]]

    # Short fuzzy fallbacks for common one-word recognition misses.
    if "拍" in normalized and len(normalized) <= 5:
        return "photo", COMMAND_LABELS["photo"]
    if "标" in normalized and ("定" in normalized or "订" in normalized or "顶" in normalized):
        return "calibrate", COMMAND_LABELS["calibrate"]
    if "采" in normalized and len(normalized) <= 5:
        return "capture", COMMAND_LABELS["capture"]
    return None


class EventBus:
    def __init__(self) -> None:
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def publish(self, kind: str, **data) -> dict:
        evt = {"kind": kind, "ts": time.time(), **data}
        with self._lock:
            subscribers = list(self._subs)
        for q in subscribers:
            try:
                q.put_nowait(evt)
            except queue.Full:
                pass
        return evt


BUS = EventBus()
_LAST_COMMAND_TS = 0.0
_LAST_COMMAND_SOURCE = ""
_LAST_COMMAND = ""
_MOBILE_SERVER = None
_MOBILE_THREAD: threading.Thread | None = None
_MOBILE_INFO: dict | None = None
_MOBILE_LOCK = threading.Lock()


def _publish_command_once(command: str, source: str, *, partial: bool = False, **extra) -> None:
    global _LAST_COMMAND_TS, _LAST_COMMAND_SOURCE, _LAST_COMMAND
    normalized = _normalize(source)
    now = time.time()
    if command == _LAST_COMMAND and normalized == _LAST_COMMAND_SOURCE and now - _LAST_COMMAND_TS < 1.2:
        return
    if partial and command == _LAST_COMMAND and now - _LAST_COMMAND_TS < 0.8:
        return
    _LAST_COMMAND = command
    _LAST_COMMAND_TS = now
    _LAST_COMMAND_SOURCE = normalized
    BUS.publish(
        "command",
        command=command,
        label=COMMAND_LABELS.get(command, command),
        source=source,
        partial=partial,
        **extra,
    )


def _sse(evt: dict) -> str:
    return f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"


def events_response() -> StreamingResponse:
    def gen():
        q = BUS.subscribe()
        yield _sse({
            "kind": "ready",
            "ts": time.time(),
            "commands": [{"command": k, "label": v} for k, v in COMMAND_LABELS.items()],
        })
        try:
            while True:
                try:
                    yield _sse(q.get(timeout=15))
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            BUS.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
    )


def _lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith("127."):
            return ip
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return "127.0.0.1"


def _voice_dir() -> Path:
    root = os.environ.get("CALIB_VOICE_DIR")
    if root:
        return Path(root)
    return Path.home() / ".calibration-workbench" / "voice"


def _cert_paths() -> tuple[Path, Path]:
    d = _voice_dir()
    return d / "mobile-voice.key.pem", d / "mobile-voice.cert.pem"


def _cert_looks_usable(cert_path: Path, host_ip: str) -> bool:
    if not cert_path.exists():
        return False
    try:
        cert = ssl._ssl._test_decode_cert(str(cert_path))  # type: ignore[attr-defined]
        not_after = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        if not_after <= datetime.now(timezone.utc) + timedelta(days=30):
            return False
        san = dict(cert.get("subjectAltName", ()))
        return san.get("IP Address") in {host_ip, "127.0.0.1"} or host_ip == "127.0.0.1"
    except Exception:
        return False


def _generate_cert_cryptography(key_path: Path, cert_path: Path, host_ip: str) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Calibration Workbench Mobile Voice"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Calibration Workbench"),
    ])
    alt_names: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    try:
        alt_names.append(x509.IPAddress(ipaddress.ip_address(host_ip)))
    except ValueError:
        pass
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=5))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _generate_cert_openssl(key_path: Path, cert_path: Path, host_ip: str) -> None:
    san = f"IP:127.0.0.1,IP:{host_ip},DNS:localhost"
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
        "-keyout", str(key_path), "-out", str(cert_path),
        "-subj", "/CN=Calibration Workbench Mobile Voice",
        "-addext", f"subjectAltName={san}",
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _ensure_certificate(host_ip: str) -> tuple[Path, Path]:
    key_path, cert_path = _cert_paths()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    if key_path.exists() and _cert_looks_usable(cert_path, host_ip):
        return key_path, cert_path

    with tempfile.TemporaryDirectory(dir=str(key_path.parent)) as td:
        tmp_key = Path(td) / "voice.key.pem"
        tmp_cert = Path(td) / "voice.cert.pem"
        try:
            _generate_cert_cryptography(tmp_key, tmp_cert, host_ip)
        except Exception:
            _generate_cert_openssl(tmp_key, tmp_cert, host_ip)
        os.replace(tmp_key, key_path)
        os.replace(tmp_cert, cert_path)
    try:
        key_path.chmod(0o600)
        cert_path.chmod(0o644)
    except OSError:
        pass
    return key_path, cert_path


def _port_available(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False


def _pick_port() -> int:
    preferred = int(os.environ.get("CALIB_VOICE_PORT", "8799"))
    if _port_available(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("0.0.0.0", 0))
        return int(s.getsockname()[1])


def _wait_tcp(port: int, timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)


def ensure_mobile_server() -> dict:
    global _MOBILE_SERVER, _MOBILE_THREAD, _MOBILE_INFO
    with _MOBILE_LOCK:
        if _MOBILE_THREAD and _MOBILE_THREAD.is_alive() and _MOBILE_INFO:
            return _MOBILE_INFO

        host_ip = _lan_ip()
        port = _pick_port()
        key_path, cert_path = _ensure_certificate(host_ip)
        url = f"https://{host_ip}:{port}/mobile"

        import uvicorn

        app = create_mobile_app(lambda: {"url": url, "ip": host_ip, "port": port, "protocol": "https"})
        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=port,
            log_level=os.environ.get("CALIB_VOICE_LOG_LEVEL", "warning"),
            access_log=False,
            ssl_keyfile=str(key_path),
            ssl_certfile=str(cert_path),
        )
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, name="calib-mobile-voice", daemon=True)
        _MOBILE_SERVER = server
        _MOBILE_THREAD = thread
        _MOBILE_INFO = {
            "ok": True,
            "url": url,
            "ip": host_ip,
            "port": port,
            "protocol": "https",
            "cert_path": str(cert_path),
            "commands": [{"command": k, "label": v} for k, v in COMMAND_LABELS.items()],
            "warning": "手机首次访问自签名 HTTPS 时需要在浏览器中继续前往。",
        }
        thread.start()
        _wait_tcp(port)
        return _MOBILE_INFO


def stop_mobile_server() -> None:
    global _MOBILE_SERVER, _MOBILE_THREAD, _MOBILE_INFO
    with _MOBILE_LOCK:
        if _MOBILE_SERVER is not None:
            _MOBILE_SERVER.should_exit = True
        _MOBILE_SERVER = None
        _MOBILE_THREAD = None
        _MOBILE_INFO = None


def info() -> dict:
    try:
        return ensure_mobile_server()
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "commands": [{"command": k, "label": v} for k, v in COMMAND_LABELS.items()],
        }


def qrcode_svg_response() -> Response:
    data = ensure_mobile_server()
    try:
        import qrcode
        import qrcode.image.svg
        factory = qrcode.image.svg.SvgPathImage
        img = qrcode.make(data["url"], image_factory=factory)
        buf = io.BytesIO()
        img.save(buf)
        content = buf.getvalue()
    except Exception:
        from app.utils.qr_svg import qrcode_svg

        content = qrcode_svg(data["url"])
    return Response(
        content=content,
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-cache, no-store"},
    )


def create_mobile_app(info_provider) -> FastAPI:
    app = FastAPI(title="Calibration Workbench Mobile Voice")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/mobile", response_class=HTMLResponse)
    async def mobile_page() -> HTMLResponse:
        return HTMLResponse(MOBILE_HTML)

    @app.get("/mobile/info")
    async def mobile_info() -> dict:
        return info_provider()

    @app.post("/mobile/event")
    async def mobile_event(payload: dict) -> dict:
        kind = payload.get("kind")
        data = payload.get("data") or {}
        if kind in ("partial", "final"):
            text = str(data.get("text") or "")
            BUS.publish(kind, text=text, source="mobile")
            matched = match_command(text)
            if matched:
                command, label = matched
                _publish_command_once(command, text, partial=(kind == "partial"), from_mobile=True)
                return {"ok": True, "matched": {"command": command, "label": label}}
        elif kind == "command":
            command = str(data.get("command") or "")
            if command in COMMAND_LABELS:
                _publish_command_once(command, str(data.get("source") or COMMAND_LABELS[command]), from_mobile=True)
                return {"ok": True, "matched": {"command": command, "label": COMMAND_LABELS[command]}}
        elif kind == "connected":
            BUS.publish("mobile_connected")
        elif kind == "disconnected":
            BUS.publish("mobile_disconnected")
        return {"ok": True}

    return app


MOBILE_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Calibration Voice</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1014;
      --panel: #151a20;
      --panel-2: #1b222a;
      --line: #2b353f;
      --text: #edf2f7;
      --muted: #8e9aa8;
      --ok: #29c178;
      --warn: #dfb24a;
      --err: #ef6a62;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.04), transparent 34%),
        var(--bg);
      color: var(--text);
      display: flex;
      align-items: stretch;
      justify-content: center;
      padding: max(18px, env(safe-area-inset-top)) 18px max(18px, env(safe-area-inset-bottom));
    }
    main {
      width: min(100%, 460px);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 14px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-top: 4px;
    }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; font-weight: 650; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .state-dot {
      width: 12px; height: 12px; border-radius: 999px;
      background: var(--warn);
      box-shadow: 0 0 0 6px rgba(223,178,74,0.12);
      flex: 0 0 auto;
    }
    body.listening .state-dot { background: var(--ok); box-shadow: 0 0 0 8px rgba(41,193,120,0.14); }
    body.error .state-dot { background: var(--err); box-shadow: 0 0 0 8px rgba(239,106,98,0.14); }
    .panel {
      background: color-mix(in srgb, var(--panel) 94%, white);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0,0,0,0.28);
    }
    .status {
      padding: 14px 16px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      font-size: 14px;
    }
    .status b { font-weight: 600; }
    .badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: var(--ok);
      background: rgba(41,193,120,0.1);
      border: 1px solid rgba(41,193,120,0.3);
      padding: 4px 7px;
      border-radius: 999px;
    }
    .badges {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .badge.dim {
      color: var(--muted);
      background: rgba(142,154,168,0.1);
      border-color: rgba(142,154,168,0.28);
    }
    .badge.warn {
      color: var(--warn);
      background: rgba(223,178,74,0.1);
      border-color: rgba(223,178,74,0.32);
    }
    .mic {
      min-height: 290px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 18px;
      gap: 18px;
      text-align: center;
    }
    .orb {
      width: 132px;
      height: 132px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 45% 35%, rgba(255,255,255,0.18), transparent 34%),
        linear-gradient(145deg, #222b33, #11161c);
      border: 1px solid #34414e;
      box-shadow: inset 0 0 32px rgba(255,255,255,0.04), 0 18px 40px rgba(0,0,0,0.35);
      position: relative;
    }
    .orb::before {
      content: "";
      width: 42px;
      height: 64px;
      border-radius: 24px;
      border: 5px solid var(--muted);
      border-bottom-width: 10px;
    }
    .orb::after {
      content: "";
      position: absolute;
      width: 56px;
      height: 38px;
      border-bottom: 5px solid var(--muted);
      border-radius: 0 0 34px 34px;
      top: 70px;
    }
    body.listening .orb {
      border-color: rgba(41,193,120,0.8);
      box-shadow: inset 0 0 38px rgba(41,193,120,0.08), 0 0 0 14px rgba(41,193,120,0.06), 0 22px 48px rgba(0,0,0,0.4);
    }
    body.listening .orb::before, body.listening .orb::after { border-color: var(--ok); }
    .command {
      min-height: 34px;
      font-size: 22px;
      font-weight: 700;
    }
    .partial {
      min-height: 44px;
      width: 100%;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .controls {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    button {
      border: 0;
      border-radius: 12px;
      min-height: 52px;
      padding: 0 16px;
      color: var(--text);
      background: var(--panel-2);
      border: 1px solid var(--line);
      font-size: 16px;
      font-weight: 650;
      letter-spacing: 0;
      touch-action: manipulation;
    }
    button.primary {
      background: var(--ok);
      color: #06110b;
      border-color: color-mix(in srgb, var(--ok) 72%, white);
    }
    button.stop {
      background: transparent;
      color: var(--err);
      border-color: rgba(239,106,98,0.42);
      display: none;
    }
    body.listening button.primary { display: none; }
    body.listening button.stop { display: block; }
    .quick {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .quick button {
      min-height: 44px;
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
    }
    .log {
      min-height: 90px;
      max-height: 150px;
      overflow: auto;
      padding: 12px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.55;
    }
    .log div { border-bottom: 1px solid rgba(255,255,255,0.04); padding: 3px 0; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>语音控制</h1>
        <div class="sub">标定 / 拍照 / 采集</div>
      </div>
      <span class="state-dot"></span>
    </header>

    <section class="panel status">
      <b id="statusText">正在连接</b>
      <span class="badges">
        <span class="badge">HTTPS</span>
        <span class="badge dim" id="wakeBadge">常亮待机</span>
      </span>
    </section>

    <section class="panel mic">
      <div class="orb" aria-hidden="true"></div>
      <div class="command" id="commandText">待机</div>
      <div class="partial" id="partialText">点击开始后，对着手机说标定、拍照或采集。</div>
    </section>

    <section class="controls">
      <button class="primary" id="startBtn">开始监听</button>
      <button class="stop" id="stopBtn">停止监听</button>
      <div class="quick">
        <button data-command="calibrate">标定</button>
        <button data-command="photo">拍照</button>
        <button data-command="capture">采集</button>
      </div>
      <div class="panel log" id="log"></div>
    </section>
  </main>

  <script>
    const COMMANDS = {
      calibrate: ["标定","标订","标顶","表定","表弟","标题","标点","校准","求解","calibrate","solve"],
      photo: ["拍照","拍摄","拍一张","拍张照","拍个照","拍一下","照相","快照","茄子","咔嚓","咔擦","卡擦","cheese","snap","photo"],
      capture: ["采集","采籍","采辑","彩集","才集","采样","收集","取样","capture","collect","acquire"]
    };
    const LABELS = { calibrate: "标定", photo: "拍照", capture: "采集" };
    const statusText = document.getElementById("statusText");
    const wakeBadge = document.getElementById("wakeBadge");
    const commandText = document.getElementById("commandText");
    const partialText = document.getElementById("partialText");
    const logEl = document.getElementById("log");
    const startBtn = document.getElementById("startBtn");
    const stopBtn = document.getElementById("stopBtn");
    let recognition = null;
    let listening = false;
    let lastPartialSent = 0;
    let wakeLock = null;
    let wakeLockWanted = false;

    function norm(text) {
      return String(text || "").toLowerCase().replace(/\s+/g, "");
    }
    function matchCommand(text) {
      const s = norm(text);
      for (const [command, aliases] of Object.entries(COMMANDS)) {
        if (aliases.some(a => s.includes(norm(a)))) return command;
      }
      if (s.includes("拍") && s.length <= 5) return "photo";
      if (s.includes("标") && (s.includes("定") || s.includes("订") || s.includes("顶"))) return "calibrate";
      if (s.includes("采") && s.length <= 5) return "capture";
      return null;
    }
    function setState(state, text) {
      document.body.classList.toggle("listening", state === "listening");
      document.body.classList.toggle("error", state === "error");
      statusText.textContent = text;
    }
    function log(text) {
      const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const div = document.createElement("div");
      div.textContent = `[${t}] ${text}`;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }
    function setWakeBadge(text, kind = "dim") {
      wakeBadge.textContent = text;
      wakeBadge.className = `badge ${kind}`;
    }
    async function requestWakeLock() {
      wakeLockWanted = true;
      if (!("wakeLock" in navigator)) {
        setWakeBadge("常亮不支持", "warn");
        return false;
      }
      if (document.visibilityState !== "visible") return false;
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        setWakeBadge("屏幕常亮", "");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
          if (wakeLockWanted && listening && document.visibilityState === "visible") {
            setWakeBadge("常亮恢复中", "warn");
            setTimeout(() => requestWakeLock(), 250);
          } else {
            setWakeBadge("常亮待机", "dim");
          }
        });
        return true;
      } catch (e) {
        wakeLock = null;
        setWakeBadge("常亮受限", "warn");
        log(`屏幕常亮失败: ${e.message || e.name || e}`);
        return false;
      }
    }
    async function releaseWakeLock() {
      wakeLockWanted = false;
      if (wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        try { await lock.release(); } catch {}
      }
      setWakeBadge("常亮待机", "dim");
    }
    async function post(kind, data) {
      try {
        const res = await fetch("/mobile/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, data })
        });
        return await res.json().catch(() => ({}));
      } catch (e) {
        log(`发送失败: ${e.message}`);
      }
    }
    function showCommand(command, source) {
      commandText.textContent = LABELS[command] || command;
      partialText.textContent = source || "";
      log(`命令 ${LABELS[command] || command}`);
    }
    function buildRecognition() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) return null;
      const r = new SpeechRecognition();
      r.lang = "zh-CN";
      r.continuous = true;
      r.interimResults = true;
      r.onstart = () => {
        listening = true;
        setState("listening", "正在监听");
        commandText.textContent = "监听中";
        log("监听已启动");
      };
      r.onerror = (event) => {
        log(`识别错误: ${event.error}`);
        if (event.error !== "no-speech") stop();
      };
      r.onend = () => {
        if (listening) {
          try { r.start(); } catch { setTimeout(() => { try { r.start(); } catch {} }, 350); }
        }
      };
      r.onresult = (event) => {
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const text = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += text;
          else interim += text;
        }
        const now = Date.now();
        if (interim) {
          partialText.textContent = interim;
          const command = matchCommand(interim);
          if (command) showCommand(command, interim);
          if (now - lastPartialSent > 280) {
            lastPartialSent = now;
            post("partial", { text: interim });
          }
        }
        if (finalText) {
          partialText.textContent = finalText;
          const command = matchCommand(finalText);
          if (command) showCommand(command, finalText);
          post("final", { text: finalText }).then((r) => {
            if (r && r.matched) showCommand(r.matched.command, finalText);
          });
        }
      };
      return r;
    }
    function start() {
      if (!window.isSecureContext) {
        setState("error", "需要 HTTPS");
        log("当前不是安全上下文");
        return;
      }
      requestWakeLock();
      recognition = buildRecognition();
      if (!recognition) {
        setState("error", "浏览器不支持");
        log("此浏览器不支持 SpeechRecognition");
        releaseWakeLock();
        return;
      }
      listening = true;
      try { recognition.start(); } catch (e) { setState("error", "启动失败"); log(e.message); releaseWakeLock(); }
    }
    function stop() {
      listening = false;
      if (recognition) {
        try { recognition.stop(); } catch {}
        recognition = null;
      }
      setState("", "已停止");
      commandText.textContent = "待机";
      log("监听已停止");
      releaseWakeLock();
    }
    startBtn.addEventListener("click", start);
    stopBtn.addEventListener("click", stop);
    document.querySelectorAll("[data-command]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const command = btn.getAttribute("data-command");
        showCommand(command, "manual");
        post("command", { command, source: "manual" });
      });
    });
    window.addEventListener("load", () => {
      post("connected", {});
      setState(window.isSecureContext ? "" : "error", window.isSecureContext ? "就绪" : "需要 HTTPS");
      if (!("wakeLock" in navigator)) setWakeBadge("常亮不支持", "warn");
      log(`${location.protocol}//${location.host}`);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && listening && wakeLockWanted && !wakeLock) {
        requestWakeLock();
      }
    });
    window.addEventListener("beforeunload", () => {
      releaseWakeLock();
      const blob = new Blob([JSON.stringify({ kind: "disconnected", data: {} })], { type: "application/json" });
      navigator.sendBeacon("/mobile/event", blob);
    });
  </script>
</body>
</html>
"""
