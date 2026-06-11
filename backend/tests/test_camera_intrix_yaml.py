from __future__ import annotations

from ruamel.yaml import YAML

from app.utils import yaml_io


def test_export_camera_intrinsics_writes_image_size(tmp_path):
    path = tmp_path / "camera_intrix.yaml"
    res = yaml_io.export_camera_intrinsics(
        "back",
        [[421.833463, 0.0, 478.955959], [0.0, 421.684779, 400.762344], [0.0, 0.0, 1.0]],
        [-0.1874941, 0.00895223, 0.00418348, 0.00085569],
        image_size=[960, 800],
        path=str(path),
    )

    assert res["slot"] == "back"
    assert res["image_size"] == [960, 800]

    data = YAML(typ="safe").load(path.read_text())
    assert data["back"]["intrix"] == [421.833463, 421.684779, 478.955959, 400.762344]
    assert data["back"]["distortion_model"] == "fisheye"
    assert data["back"]["image_size"] == [960, 800]


def test_load_camera_intrix_selects_requested_slot(tmp_path):
    path = tmp_path / "camera_intrix.yaml"
    path.write_text(
        """
head:
    sn: LRCP_imx307_01_LRCP_imx307_01_200901010001
    intrix: [419.602433, 419.347577, 475.958192, 387.266089]
    distortion_coeff: [-0.19537646, 0.02176567, -0.00163033, 5.53e-06]
    distortion_model: fisheye
    image_size: [960, 800]
back:
    sn: LRCP_imx307_04_LRCP_imx307_04_200901010001
    intrix: [421.833463, 421.684779, 478.955959, 400.762344]
    distortion_coeff: [-0.1874941, 0.00895223, 0.00418348, 0.00085569]
    distortion_model: fisheye
    image_size: [960, 800]
""".lstrip()
    )

    resp = yaml_io.load_calibration(str(path), slot="back")
    data = resp.data

    assert resp.kind == "fisheye"
    assert data["camera_slot"] == "back"
    assert data["K"] == [[421.833463, 0.0, 478.955959], [0.0, 421.684779, 400.762344], [0.0, 0.0, 1.0]]
    assert data["D"] == [-0.1874941, 0.00895223, 0.00418348, 0.00085569]
    assert data["model"] == "fisheye"
    assert data["image_size"] == [960, 800]


def test_load_camera_intrix_defaults_to_head(tmp_path):
    path = tmp_path / "camera_intrix.yaml"
    path.write_text(
        """
back:
    intrix: [421, 422, 479, 401]
    distortion_coeff: [0.1, 0.2, 0.3, 0.4]
    distortion_model: fisheye
head:
    intrix: [419, 420, 476, 387]
    distortion_coeff: [0.5, 0.6, 0.7, 0.8]
    distortion_model: fisheye
""".lstrip()
    )

    data = yaml_io.load_calibration(str(path)).data

    assert data["camera_slot"] == "head"
    assert data["K"][0] == [419.0, 0.0, 476.0]
    assert data["D"] == [0.5, 0.6, 0.7, 0.8]

