import json

import pytest

from app.sources import control_store as cs


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    p = tmp_path / "camera-controls.json"
    monkeypatch.setenv("CALIB_CONTROL_STORE", str(p))
    return p


def test_missing_file_reads_as_empty(store):
    assert not store.exists()
    assert cs.load() == {"version": cs.SCHEMA_VERSION, "devices": {}}
    assert cs.list_presets("cam1") == {"active": None, "presets": {}}
    assert cs.active_controls("cam1") is None


def test_corrupt_file_does_not_raise(store):
    store.write_text("{not json at all")
    # A broken config must never stop a camera from opening.
    assert cs.load()["devices"] == {}
    assert cs.active_controls("cam1") is None


def test_file_with_wrong_shape_is_replaced(store):
    store.write_text(json.dumps([1, 2, 3]))
    assert cs.load() == {"version": cs.SCHEMA_VERSION, "devices": {}}


def test_devices_of_wrong_type_is_reset(store):
    store.write_text(json.dumps({"version": 1, "devices": "nope"}))
    assert cs.load()["devices"] == {}


def test_save_and_activate_a_preset():
    cs.save_preset("cam1", "serial", "室内", {"auto_exposure": 1, "exposure_time_absolute": 300})
    info = cs.list_presets("cam1")
    assert info["active"] == "室内"
    assert info["presets"]["室内"] == {"auto_exposure": 1, "exposure_time_absolute": 300}
    assert cs.active_controls("cam1") == {"auto_exposure": 1, "exposure_time_absolute": 300}


def test_saving_a_preset_makes_it_active():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.save_preset("cam1", "serial", "b", {"gain": 2})
    assert cs.list_presets("cam1")["active"] == "b"


def test_overwriting_a_preset_keeps_one_entry():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.save_preset("cam1", "serial", "a", {"gain": 9})
    info = cs.list_presets("cam1")
    assert list(info["presets"]) == ["a"]
    assert info["presets"]["a"] == {"gain": 9}


def test_preset_name_is_trimmed_and_must_be_nonempty():
    cs.save_preset("cam1", "serial", "  室内  ", {"gain": 1})
    assert "室内" in cs.list_presets("cam1")["presets"]
    with pytest.raises(ValueError):
        cs.save_preset("cam1", "serial", "   ", {"gain": 1})


def test_delete_clears_active_when_deleting_the_active_preset():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.delete_preset("cam1", "a")
    info = cs.list_presets("cam1")
    assert info["presets"] == {}
    assert info["active"] is None
    assert cs.active_controls("cam1") is None


def test_delete_keeps_active_when_deleting_another_preset():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.save_preset("cam1", "serial", "b", {"gain": 2})   # b becomes active
    cs.delete_preset("cam1", "a")
    assert cs.list_presets("cam1")["active"] == "b"


def test_delete_unknown_preset_is_a_noop():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.delete_preset("cam1", "does-not-exist")
    assert cs.list_presets("cam1")["active"] == "a"


def test_set_active_none_clears_and_restores_legacy_behaviour():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.set_active("cam1", "serial", None)
    # None is meaningful: the open path falls back to force-auto-exposure.
    assert cs.active_controls("cam1") is None


def test_set_active_unknown_name_raises():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    with pytest.raises(KeyError):
        cs.set_active("cam1", "serial", "nope")


def test_devices_are_isolated_from_each_other():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.save_preset("cam2", "serial", "a", {"gain": 99})
    assert cs.active_controls("cam1") == {"gain": 1}
    assert cs.active_controls("cam2") == {"gain": 99}


def test_active_preset_with_empty_values_reads_as_none():
    cs.save_preset("cam1", "serial", "a", {})
    # An empty preset must not be mistaken for "user configured nothing" AND must
    # not suppress the legacy guard — both point at returning None.
    assert cs.active_controls("cam1") is None


def test_non_numeric_values_are_dropped_not_crashed(store):
    store.write_text(json.dumps({
        "version": 1,
        "devices": {"cam1": {"keyed_by": "serial", "active": "a",
                             "presets": {"a": {"gain": 5, "junk": "oops"}}}},
    }))
    assert cs.active_controls("cam1") == {"gain": 5}


def test_device_key_prefers_serial():
    assert cs.device_key("/dev/video0", "SN123") == ("SN123", "serial")


def test_device_key_falls_back_to_path_and_records_why():
    key, how = cs.device_key("/dev/video0", None)
    assert (key, how) == ("/dev/video0", "path")
    cs.save_preset(key, how, "a", {"gain": 1})
    assert cs.load()["devices"]["/dev/video0"]["keyed_by"] == "path"


def test_write_is_atomic_and_leaves_no_temp_files(store):
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    leftovers = list(store.parent.glob(".camera-controls-*.tmp"))
    assert leftovers == []
    assert json.loads(store.read_text())["devices"]["cam1"]["presets"]["a"] == {"gain": 1}


def test_unicode_preset_names_round_trip(store):
    cs.save_preset("cam1", "serial", "强光下", {"gain": 1})
    raw = store.read_text()
    assert "强光下" in raw          # not \u-escaped, so the file stays readable
    assert "强光下" in cs.list_presets("cam1")["presets"]


def test_live_edit_lands_in_the_active_preset():
    cs.save_preset("cam1", "serial", "室内", {"gain": 1})
    cs.remember_value("cam1", "serial", "gain", 77)
    assert cs.list_presets("cam1")["presets"]["室内"] == {"gain": 77}


def test_live_edit_with_no_active_preset_creates_an_implicit_one():
    cs.remember_value("cam1", "serial", "gain", 42)
    info = cs.list_presets("cam1")
    assert info["active"] == cs.IMPLICIT_PRESET
    assert info["presets"][cs.IMPLICIT_PRESET] == {"gain": 42}
    # The whole point: the value survives a stream restart.
    assert cs.active_controls("cam1") == {"gain": 42}


def test_live_edit_after_clearing_active_recreates_the_implicit_preset():
    cs.save_preset("cam1", "serial", "a", {"gain": 1})
    cs.set_active("cam1", "serial", None)
    cs.remember_value("cam1", "serial", "gain", 5)
    info = cs.list_presets("cam1")
    assert info["active"] == cs.IMPLICIT_PRESET
    assert set(info["presets"]) == {"a", cs.IMPLICIT_PRESET}
    # The named preset must not be touched by an edit made after it was deactivated.
    assert info["presets"]["a"] == {"gain": 1}


def test_live_edits_accumulate():
    cs.remember_value("cam1", "serial", "gain", 1)
    cs.remember_value("cam1", "serial", "brightness", 2)
    assert cs.active_controls("cam1") == {"gain": 1, "brightness": 2}
