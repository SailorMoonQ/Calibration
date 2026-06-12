"""ARX X5 双臂位姿源：订阅 /arx/dual_arm_status，把末端位姿推进 pose stream。

用于手眼标定标签页实时显示机械臂末端位姿（手眼标定的 B 端）。两条臂各暴露
一个 device：`arx_ee_l` / `arx_ee_r`，位姿取 `end_pos_status`（base → 末端法兰）。

依赖 rclpy + mibot_interface，运行前需 source ROS2 环境（与机器人同 DOMAIN_ID）。
"""
from __future__ import annotations

import logging
import math
import threading

from app.sources.poses import PoseSource
from app.sources import ros2_context

log = logging.getLogger("calib.source.arx")

DEVICES = ["arx_ee_l", "arx_ee_r"]
STATUS_TOPIC = "/arx/dual_arm_status"


def _pose_msg_to_4x4(pose) -> list[list[float]] | None:
    """geometry_msgs/Pose → 4x4 row-major nested list。零四元数返回 None。"""
    p = pose.position
    o = pose.orientation
    qx, qy, qz, qw = o.x, o.y, o.z, o.w
    n = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if n < 1e-9:
        return None
    qx, qy, qz, qw = qx / n, qy / n, qz / n, qw / n
    x, y, z = p.x, p.y, p.z
    return [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw),     2 * (qx * qz + qy * qw),     x],
        [2 * (qx * qy + qz * qw),     1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),     y],
        [2 * (qx * qz - qy * qw),     2 * (qy * qz + qx * qw),     1 - 2 * (qx * qx + qy * qy), z],
        [0.0, 0.0, 0.0, 1.0],
    ]


class ArxPoseSource(PoseSource):
    def __init__(self) -> None:
        try:
            from mibot_interface.msg import DualArxX5Status
        except ImportError as e:
            raise RuntimeError(
                "ARX support unavailable — source the robot's ROS2 workspace "
                "(install/setup.bash) before launching the backend"
            ) from e
        from rclpy.qos import qos_profile_sensor_data

        # 共享的 rclpy context（与 ros2 图像源同一套，复用上下文与 spin 线程）
        node = ros2_context.ensure_started()
        self._lock = threading.Lock()
        self._latest = {dev: None for dev in DEVICES}

        self._sub = node.create_subscription(
            DualArxX5Status, STATUS_TOPIC, self._on_status, qos_profile_sensor_data
        )
        log.info("ArxPoseSource subscribed · %s", STATUS_TOPIC)

    def _on_status(self, msg) -> None:
        l = _pose_msg_to_4x4(msg.left_arm.end_pos_status)
        r = _pose_msg_to_4x4(msg.right_arm.end_pos_status)
        with self._lock:
            self._latest["arx_ee_l"] = l
            self._latest["arx_ee_r"] = r

    def hello(self) -> dict:
        return {"devices": list(DEVICES), "gt_T_a_b": None, "bases": 0}

    def poll(self, t: float) -> dict[str, list[list[float]]]:
        with self._lock:
            return {dev: m for dev, m in self._latest.items() if m is not None}

    def close(self) -> None:
        try:
            node = ros2_context.get_node()
            if node is not None:
                node.destroy_subscription(self._sub)
        except Exception:
            log.exception("ArxPoseSource close failed")
