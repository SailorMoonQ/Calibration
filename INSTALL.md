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
  'numpy>=1.26,<2' \
  opencv-contrib-python>=4.10 \
  scipy>=1.13 \
  ruamel.yaml>=0.18
```

**Important — NumPy must be `<2`.** ROS2 Humble's `cv_bridge` is built
against NumPy 1.x and segfaults when loaded alongside NumPy 2.x. If you
already have NumPy 2 installed, downgrade with `pip3 install --user 'numpy<2'`.

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
- **PICO (XRoboToolkit)**: see the detailed steps below — the Python
  module is built from source, not installed from PyPI.

### PICO tracker (XRoboToolkit)

PICO has no first-party Python pose SDK, so we use XRoboToolkit.
`xrobotoolkit_sdk` is **not on PyPI** — build it from source:

1. **Headset:** install the XRoboToolkit client APK on the PICO
   (`adb install <client>.apk`) and launch it.
2. **PC Service:** build and run `XRoboToolkit-PC-Service` (the daemon that
   receives poses from the headset). It is single-instance — start it before
   connecting from the Workbench.
3. **Python module:** initialize the submodule and build it into the backend's
   Python environment. The pybind module links a native `libPXREARobotSDK.so`
   that you build from the PC-Service repo first:
   ```bash
   git submodule update --init third_party/XRoboToolkit-PC-Service-Pybind
   cd third_party/XRoboToolkit-PC-Service-Pybind

   # 1. build the native SDK lib
   mkdir -p tmp && cd tmp
   git clone https://github.com/XR-Robotics/XRoboToolkit-PC-Service.git
   (cd XRoboToolkit-PC-Service/RoboticsService/PXREARobotSDK && bash build.sh)
   cd ..

   # 2. stage the header + lib the pybind build expects
   mkdir -p lib include
   cp tmp/XRoboToolkit-PC-Service/RoboticsService/PXREARobotSDK/PXREARobotSDK.h include/
   cp -r tmp/XRoboToolkit-PC-Service/RoboticsService/PXREARobotSDK/nlohmann include/nlohmann/
   cp tmp/XRoboToolkit-PC-Service/RoboticsService/PXREARobotSDK/build/libPXREARobotSDK.so lib/

   # 3. build the Python module into the backend venv
   ../../backend/.venv/bin/pip install pybind11
   ../../backend/.venv/bin/python setup.py install
   ```
   Build prereqs: `cmake` (≥3.1), a C++17 compiler, and the Python dev headers
   (`python3-dev`). The installed module embeds an RPATH to the `lib/` above, so
   keep the submodule's `lib/libPXREARobotSDK.so` in place after building.
4. **Verify:** `backend/.venv/bin/python -c "import xrobotoolkit_sdk; print('ok')"`
   should print `ok` (importable without hardware). With the PC Service running
   and a headset connected, `xrobotoolkit_sdk.init()` then connects to the stream.

In the app, pick **PICO** as the tracker source (Hand-Eye) or slot backend
(Link). Devices: `pico_ctrl_l`, `pico_ctrl_r`, `pico_hmd`. No adb-IP field is
needed — the PC Service owns the headset link.

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
