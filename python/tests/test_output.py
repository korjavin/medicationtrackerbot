import importlib

import pytest

import medtracker.exceptions as exc

# medtracker/__init__.py exports `output` as a function, shadowing the submodule
# via attribute access. importlib bypasses that and returns the actual module.
out = importlib.import_module("medtracker.output")


@pytest.fixture(autouse=True)
def reset_output_state():
    out._reset()
    yield
    out._reset()


class TestOutput:
    def test_records_dict_value(self):
        out.output({"count": 42})
        assert out._get_output() == {"count": 42}
        assert out._is_output_set() is True

    def test_records_list_value(self):
        out.output([1, 2, 3])
        assert out._get_output() == [1, 2, 3]

    def test_records_string_value(self):
        out.output("hello world")
        assert out._get_output() == "hello world"

    def test_records_numeric_value(self):
        out.output(3.14)
        assert out._get_output() == pytest.approx(3.14)

    def test_accepts_none_value(self):
        # None serializes to JSON null — it's valid
        out.output(None)
        assert out._is_output_set() is True
        assert out._get_output() is None

    def test_not_called_returns_not_set(self):
        assert out._is_output_set() is False
        assert out._get_output() is None

    def test_single_output_enforced(self):
        out.output({"first": True})
        with pytest.raises(RuntimeError, match="once"):
            out.output({"second": True})

    def test_single_output_enforced_second_call_not_stored(self):
        out.output({"first": True})
        with pytest.raises(RuntimeError):
            out.output({"second": True})
        assert out._get_output() == {"first": True}

    def test_non_serializable_raises_serialization_error(self):
        with pytest.raises(exc.SerializationError):
            out.output(object())

    def test_non_serializable_does_not_set_state(self):
        with pytest.raises(exc.SerializationError):
            out.output(object())
        assert out._is_output_set() is False
        assert out._get_output() is None

    def test_serialization_error_is_medtracker_error(self):
        with pytest.raises(exc.MedtrackerError):
            out.output(lambda: None)

    def test_reset_clears_state(self):
        out.output({"data": 1})
        out._reset()
        assert out._is_output_set() is False
        assert out._get_output() is None

    def test_can_call_output_after_reset(self):
        out.output({"first": 1})
        out._reset()
        out.output({"second": 2})
        assert out._get_output() == {"second": 2}
