from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class Board(BaseModel):
    type: Literal["chess", "charuco"] = "chess"
    cols: int = 9
    rows: int = 6
    square: float = 0.025
    marker: float | None = None
    dictionary: str = "DICT_5X5_100"


class DetectRequest(BaseModel):
    image_b64: str
    board: Board


class DetectFileRequest(BaseModel):
    path: str
    board: Board


class DetectResponse(BaseModel):
    detected: bool
    corners: list[tuple[float, float]] = Field(default_factory=list)
    ids: list[int] | None = None
    rms: float | None = None
    image_size: tuple[int, int] | None = None


class IntrinsicsRequest(BaseModel):
    board: Board
    model: Literal["pinhole-k3", "pinhole-k5", "pinhole-rt"] = "pinhole-k3"
    fix_aspect: bool = False
    estimate_skew: bool = True
    # Either provide a directory of images on disk (preferred) or inline base64 frames.
    dataset_path: str | None = None
    frames_b64: list[str] = Field(default_factory=list)


class FisheyeRequest(BaseModel):
    board: Board
    model: Literal["equidistant", "kb", "omni"] = "equidistant"
    dataset_path: str | None = None
    frames_b64: list[str] = Field(default_factory=list)


class ExtrinsicsRequest(BaseModel):
    board: Board
    dataset_path_0: str | None = None
    dataset_path_1: str | None = None
    # Inline frames only if no dataset paths are set (kept for parity with other requests).
    cam0_frames_b64: list[str] = Field(default_factory=list)
    cam1_frames_b64: list[str] = Field(default_factory=list)
    # Per-camera intrinsics are required — stereo runs CALIB_FIX_INTRINSIC.
    K0: list[list[float]]
    D0: list[float]
    K1: list[list[float]]
    D1: list[float]


class HandEyeRequest(BaseModel):
    method: Literal["tsai", "park", "horaud", "daniilidis", "andreff"] = "park"
    kind: Literal["hmd", "ctrl"] = "hmd"
    board: Board | None = None
    # Dataset-driven path: images + tracker poses JSON (basename→4x4) + camera intrinsics.
    dataset_path: str | None = None
    poses_path: str | None = None
    K: list[list[float]] | None = None
    D: list[float] | None = None
    # Inline fallback: A = T_cam_board per frame, B = T_base_tracker per frame. 4x4 each.
    A: list[list[list[float]]] = Field(default_factory=list)
    B: list[list[list[float]]] = Field(default_factory=list)


class ChainRequest(BaseModel):
    # Rigid-link solve: given per-frame T_base_a and T_base_b (basename → 4x4 in each JSON),
    # recover the rigid T_a_b such that T_base_b ≈ T_base_a · T_a_b.
    poses_a_path: str
    poses_b_path: str
    link_label: str = "a_b"


class LinkRequest(BaseModel):
    # Same solver as ChainRequest but poses come inline (from a live collector rather than
    # JSON on disk). Keyed by arbitrary sample id; the solver matches by common keys.
    poses_a: dict[str, list[list[float]]]
    poses_b: dict[str, list[list[float]]]
    link_label: str = "a_b"


class CalibrationResult(BaseModel):
    ok: bool
    rms: float
    K: list[list[float]] | None = None
    D: list[float] | None = None
    T: list[list[float]] | None = None  # hand-eye / extrinsics result
    image_size: tuple[int, int] | None = None
    per_frame_err: list[float] = Field(default_factory=list)
    # aligned with detected_paths; each entry is a list of [x, y, ex, ey]
    # where (ex, ey) = detected - reprojected (image-space pixels)
    per_frame_residuals: list[list[tuple[float, float, float, float]]] = Field(default_factory=list)
    detected_paths: list[str] = Field(default_factory=list)
    iterations: int = 0
    final_cost: float = 0.0
    message: str = ""


class CalibrationSavePayload(BaseModel):
    path: str
    kind: Literal["intrinsics", "fisheye", "extrinsics", "handeye", "chain"] = "intrinsics"
    result: CalibrationResult
    board: Board | None = None
    dataset_path: str | None = None
    notes: str | None = None


class CalibrationLoadResponse(BaseModel):
    path: str
    kind: str
    data: dict


class DatasetListResponse(BaseModel):
    path: str
    count: int
    files: list[str]
