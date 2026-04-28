"""Process-wide rclpy singleton.

Lazy-init on first use. One Node + one MultiThreadedExecutor running on a
daemon thread are shared by every Ros2ImageSource and by the topic-listing
endpoint. rclpy is imported lazily so the backend can boot without a sourced
ROS2 environment; the import error surfaces at the moment the user actually
needs ROS2.
"""
from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from rclpy.node import Node

log = logging.getLogger("calib.ros2")

_lock = threading.Lock()
_node: "Node | None" = None
_executor = None
_thread: threading.Thread | None = None
_started = False


def ensure_started() -> "Node":
    """Lazy-init rclpy. Idempotent. Raises RuntimeError if rclpy is unavailable."""
    global _node, _executor, _thread, _started
    with _lock:
        if _started and _node is not None:
            return _node
        try:
            import rclpy
            from rclpy.executors import MultiThreadedExecutor
            from rclpy.node import Node
        except ImportError as e:
            raise RuntimeError(
                "rclpy unavailable — source ROS2 setup before launching backend"
            ) from e
        if not rclpy.ok():
            rclpy.init(args=None)
        _node = Node("calib_backend")
        _executor = MultiThreadedExecutor()
        _executor.add_node(_node)
        _thread = threading.Thread(
            target=_executor.spin, name="ros2-spin", daemon=True
        )
        _thread.start()
        _started = True
        log.info("ros2 context started · node=calib_backend")
        return _node


def get_node() -> "Node | None":
    """Return the running node, or None if ensure_started has not been called."""
    return _node


def list_compressed_image_topics() -> list[dict]:
    """Filter live graph topics to sensor_msgs/msg/CompressedImage."""
    node = ensure_started()
    out = []
    for topic, types in node.get_topic_names_and_types():
        if "sensor_msgs/msg/CompressedImage" in types:
            out.append({"topic": topic, "n_publishers": node.count_publishers(topic)})
    out.sort(key=lambda x: x["topic"])
    return out


def shutdown() -> None:
    """Tear down the executor + node + rclpy. Safe to call when never started."""
    global _node, _executor, _thread, _started
    with _lock:
        if not _started:
            return
        try:
            import rclpy
        except ImportError:
            return
        if _executor is not None:
            _executor.shutdown()
        if _node is not None:
            _node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
        _node = None
        _executor = None
        _thread = None
        _started = False
        log.info("ros2 context shut down")
