"""The app version lives in three files that nothing keeps in agreement.

package.json is what electron-builder stamps on the installer, pyproject.toml is
the backend's build metadata, and app.__version__ is what /health reports to the
UI. They had drifted to 0.3.0 / 0.2.0 / 0.1.0 — so the version a user reads off
the About box, the one in the package, and the one the backend admits to were
three different numbers. Deriving one from another is not workable here (the
backend ships as loose source under resources/, not as an installed
distribution), so they stay three literals and this test is the thing that
stops them drifting again.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import app

_REPO = Path(__file__).resolve().parents[2]


def _package_json_version() -> str:
    return json.loads((_REPO / "package.json").read_text(encoding="utf-8"))["version"]


def _pyproject_version() -> str:
    text = (_REPO / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, "no version field in backend/pyproject.toml"
    return match.group(1)


def test_the_three_version_declarations_agree() -> None:
    assert app.__version__ == _package_json_version() == _pyproject_version()
