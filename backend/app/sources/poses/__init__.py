"""Pose sources for the Link tab WS stream.

A `PoseSource` emits a `hello()` envelope (device list + optional ground truth)
once on connect, then `poll()` returns the latest `{device: 4x4_list}` for each
tick. The stream route handles framing and timing; sources just return data.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class PoseSource(ABC):
    @abstractmethod
    def hello(self) -> dict:
        """Initial envelope: {'devices': [...], 'gt_T_a_b': [[..]] | None}."""

    @abstractmethod
    def poll(self, t: float) -> dict[str, list[list[float]]]:
        """Return {device_id: 4x4 pose as nested list} for this tick.

        `t` is seconds since stream start; sources that synthesize motion use it,
        sources that sample hardware ignore it.
        """

    def close(self) -> None:  # noqa: B027 — optional hook
        pass
