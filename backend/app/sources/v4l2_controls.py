"""Read and write a V4L2 camera's controls (exposure, gain, white balance, focus…).

Talks to the driver through `v4l2-ctl`, the same way `opencv._force_auto_exposure`
already does — no new dependency, and it works against whatever the driver happens
to expose rather than a hard-coded list, so an unfamiliar camera still gets a
usable panel.

The text parsing is deliberately split out as a pure function (`parse_controls`)
so it can be tested against captured real-world output without a camera attached.
Everything that touches a subprocess is a thin wrapper around it.

This module knows nothing about presets or persistence — see `control_store`.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess

log = logging.getLogger("calib.v4l2")

_DEV_RE = re.compile(r"^/dev/video\d+$")

# One control line, e.g.
#     brightness 0x00980900 (int)  : min=-64 max=64 step=1 default=0 value=40
#     white_balance_automatic 0x0098090c (bool) : default=1 value=1
#     power_line_frequency 0x00980918 (menu) : min=0 max=2 default=1 value=1 (50 Hz)
_CTRL_RE = re.compile(
    r"^\s*(?P<id>\w+)\s+0x(?P<hex>[0-9a-fA-F]+)\s+\((?P<type>\w+)\)\s*:\s*(?P<rest>.*)$"
)
# A menu option line, indented under its control: "\t\t\t\t1: Manual Mode"
_MENU_RE = re.compile(r"^\s+(?P<value>-?\d+):\s*(?P<label>.+?)\s*$")
_KV_RE = re.compile(r"(\w+)=(-?\d+)")

# Section headers in `--list-ctrls-menus` output.
_GROUPS = {"user controls": "user", "camera controls": "camera", "codec controls": "codec"}

# V4L2 reports `flags=inactive` but not WHICH control is holding the lock, so we
# infer it from a table. The value is what the parent must be set to in order to
# release the lock (e.g. auto_exposure=1 is "Manual Mode").
#
# Both the modern and the legacy driver spellings are listed: kernels before ~5.10
# used `exposure_auto` / `focus_auto`, and plenty of cameras in the field still
# report the old names.
LOCK_PARENTS: dict[str, tuple[str, int]] = {
    "exposure_time_absolute": ("auto_exposure", 1),
    "exposure_absolute": ("exposure_auto", 1),
    "white_balance_temperature": ("white_balance_automatic", 0),
    "focus_absolute": ("focus_automatic_continuous", 0),
    "pan_absolute": ("pan_auto", 0),
    "tilt_absolute": ("tilt_auto", 0),
    "iris_absolute": ("iris_auto", 0),
}

# Shown first in the UI. Order matters — it is the order operators reach for them
# when setting up a calibration session.
COMMON_ORDER = [
    "auto_exposure",
    "exposure_auto",
    "exposure_time_absolute",
    "exposure_absolute",
    "gain",
    "brightness",
    "white_balance_automatic",
    "white_balance_temperature",
    "focus_automatic_continuous",
    "focus_absolute",
]


def is_v4l2_device(device: str) -> bool:
    """Only /dev/videoN paths can carry V4L2 controls. ROS2 topics and file
    sources land here too, and must be told apart rather than probed."""
    return bool(device) and bool(_DEV_RE.match(device))


def parse_controls(text: str | None) -> list[dict]:
    """Parse `v4l2-ctl --list-ctrls-menus` output into control dicts.

    Pure: no subprocess, no filesystem. Unparseable lines are skipped rather than
    raising — a driver that emits an unexpected line should cost us that one
    control, not the whole panel.
    """
    controls: list[dict] = []
    group = "user"
    current: dict | None = None

    for raw in (text or "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue

        header = line.strip().lower()
        if header in _GROUPS:
            group = _GROUPS[header]
            current = None
            continue

        m = _CTRL_RE.match(line)
        if m:
            rest = m.group("rest")
            kv = {k: int(v) for k, v in _KV_RE.findall(rest)}
            ctype = m.group("type")
            if ctype not in ("int", "bool", "menu", "int64", "intmenu"):
                # button/string/bitmask controls have no meaningful slider — skip
                # them rather than rendering a widget that cannot work.
                current = None
                continue
            ctrl = {
                "id": m.group("id"),
                "type": "menu" if ctype == "intmenu" else ctype,
                "group": group,
                "value": kv.get("value"),
                "default": kv.get("default"),
                "inactive": "flags=inactive" in rest,
                "locked_by": None,
            }
            if ctrl["type"] == "bool":
                ctrl["min"], ctrl["max"], ctrl["step"] = 0, 1, 1
            else:
                ctrl["min"] = kv.get("min")
                ctrl["max"] = kv.get("max")
                ctrl["step"] = kv.get("step", 1)
            if ctrl["type"] == "menu":
                ctrl["menu"] = []
            if ctrl["inactive"]:
                parent = LOCK_PARENTS.get(ctrl["id"])
                if parent:
                    ctrl["locked_by"] = {"id": parent[0], "unlock_value": parent[1]}
            controls.append(ctrl)
            current = ctrl
            continue

        # Menu option lines only make sense directly under a menu control.
        if current is not None and current.get("type") == "menu":
            mm = _MENU_RE.match(raw)
            if mm:
                current["menu"].append(
                    {"value": int(mm.group("value")), "label": mm.group("label")}
                )

    return controls


def sort_controls(controls: list[dict]) -> list[dict]:
    """Common controls first (in COMMON_ORDER), then the rest in driver order.

    Pure — separated from parsing so the ordering policy can be changed and tested
    on its own.
    """
    rank = {name: i for i, name in enumerate(COMMON_ORDER)}
    common = [c for c in controls if c["id"] in rank]
    common.sort(key=lambda c: rank[c["id"]])
    rest = [c for c in controls if c["id"] not in rank]
    for c in common:
        c["common"] = True
    for c in rest:
        c["common"] = False
    return common + rest


def _run(args: list[str], timeout: float = 3.0) -> tuple[int, str, str]:
    bin_ = shutil.which("v4l2-ctl")
    if not bin_:
        return 127, "", "v4l2-ctl not installed"
    try:
        p = subprocess.run(
            [bin_, *args], check=False, capture_output=True, text=True, timeout=timeout
        )
        return p.returncode, p.stdout, p.stderr
    except Exception as e:  # pragma: no cover — tolerant of missing tooling
        log.debug("v4l2-ctl %s failed: %s", args, e)
        return 1, "", str(e)


def list_controls(device: str) -> dict:
    """Enumerate the device's controls. Never raises: an unsupported source or a
    missing v4l2-ctl comes back as supported=False with a machine-readable reason,
    so the UI can explain itself instead of showing an empty panel."""
    if not is_v4l2_device(device):
        return {"supported": False, "reason": "not-a-v4l2-device", "controls": []}
    if not shutil.which("v4l2-ctl"):
        return {"supported": False, "reason": "v4l2-ctl-missing", "controls": []}
    code, out, err = _run(["-d", device, "--list-ctrls-menus"])
    if code != 0:
        return {"supported": False, "reason": err.strip() or "v4l2-ctl-failed", "controls": []}
    controls = sort_controls(parse_controls(out))
    if not controls:
        return {"supported": False, "reason": "no-controls-exposed", "controls": []}
    return {"supported": True, "reason": None, "controls": controls}


def set_control(device: str, name: str, value: int) -> dict:
    """Set one control. Takes effect on the running stream — no camera restart,
    because v4l2 control writes are independent of the capture buffers."""
    if not is_v4l2_device(device):
        return {"ok": False, "error": "not-a-v4l2-device"}
    code, _, err = _run(["-d", device, "-c", f"{name}={int(value)}"])
    if code != 0:
        return {"ok": False, "error": err.strip() or f"v4l2-ctl exited {code}"}
    return {"ok": True, "error": None}


def apply_controls(device: str, values: dict[str, int]) -> dict:
    """Apply a whole set of controls, parents before children.

    Ordering matters: writing `exposure_time_absolute` while `auto_exposure` is
    still on auto is silently ignored by the driver. Each control is attempted
    independently so one rejected key (e.g. a preset carried over from a different
    camera) cannot stop the rest from landing."""
    applied: list[str] = []
    failed: dict[str, str] = {}
    for name in _apply_order(values):
        r = set_control(device, name, values[name])
        if r["ok"]:
            applied.append(name)
        else:
            failed[name] = r["error"] or "unknown"
    if failed:
        log.info("%s: %d control(s) rejected: %s", device, len(failed), failed)
    return {"applied": applied, "failed": failed}


def _apply_order(values: dict[str, int]) -> list[str]:
    """Parents (per LOCK_PARENTS) first, then everything else. Pure."""
    parents = {p[0] for p in LOCK_PARENTS.values()}
    first = [k for k in values if k in parents]
    rest = [k for k in values if k not in parents]
    return first + rest


def device_serial(device: str) -> str | None:
    """The camera's USB serial, used as a stable identity across re-plug —
    /dev/videoN is not stable, the serial is. None when unavailable."""
    if not is_v4l2_device(device):
        return None
    code, out, _ = _run(["-d", device, "--info"])
    if code != 0:
        return None
    for line in out.splitlines():
        if "Serial" in line and ":" in line:
            serial = line.split(":", 1)[1].strip()
            if serial:
                return serial
    return None


def supports_hw_crop(device: str) -> dict:
    """Whether the driver implements VIDIOC_S_SELECTION for cropping.

    Most UVC cameras do not — the UVC spec has no standard crop control — while
    many MIPI/CSI drivers do. Reported to the UI so an operator knows whether an
    ROI will cost resolution (software crop) or not (hardware crop)."""
    if not is_v4l2_device(device):
        return {"supported": False, "reason": "not-a-v4l2-device"}
    code, out, err = _run(["-d", device, "--get-selection=target=crop"])
    if code != 0 or "Invalid argument" in (err or "") or "failed" in (err or "").lower():
        return {"supported": False, "reason": "driver-has-no-crop-selection"}
    if "Selection" not in out:
        return {"supported": False, "reason": "driver-has-no-crop-selection"}
    return {"supported": True, "reason": None}
