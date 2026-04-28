# Installing Calibration Workbench on a target Linux machine

The AppImage bundles the Electron renderer and the Python backend source.
The backend runs against the **system Python 3** on the target machine
(no venv, no PyInstaller). You need to install the runtime dependencies
once, then the AppImage is portable.

## 1. System Python dependencies

The backend imports these on every launch:

```bash
sudo apt install -y python3-pip
pip3 install --user \
  fastapi>=0.115 \
  'uvicorn[standard]>=0.32' \
  pydantic>=2.9 \
  numpy>=1.26 \
  opencv-contrib-python>=4.10 \
  scipy>=1.13 \
  ruamel.yaml>=0.18
```

## 2. ROS2 dependencies (for the ros2 image source)

To use the **ros2** source toggle in the Fisheye / Pinhole tabs:

```bash
# Install ROS2 Humble per https://docs.ros.org/en/humble/Installation.html
sudo apt install -y \
  ros-humble-rclpy \
  ros-humble-cv-bridge \
  ros-humble-sensor-msgs
```

The user's shell must source the ROS2 setup **before launching the
AppImage**, otherwise `import rclpy` will fail and the picker will show
the *"rclpy unavailable"* hint:

```bash
source /opt/ros/humble/setup.bash
./Calibration\ Workbench-0.1.0-x86_64.AppImage
```

The USB camera path works regardless of whether ROS2 is sourced.

## 3. Optional: pose sources

- **SteamVR / Vive trackers**: install SteamVR; the backend reads via
  `triad-openvr` (install with `pip3 install --user triad-openvr`).
- **Quest3 (Oculus)**: requires `adb` on the host and the OculusReader
  APK on the device (see `third_party/oculus_reader/`).

## 4. Run

Make the AppImage executable and launch it:

```bash
chmod +x Calibration\ Workbench-0.1.0-x86_64.AppImage
./Calibration\ Workbench-0.1.0-x86_64.AppImage
```

If you keep the system Python somewhere unusual, override the
interpreter via `CALIB_PYTHON`:

```bash
CALIB_PYTHON=/usr/bin/python3.10 ./Calibration\ Workbench-*.AppImage
```
