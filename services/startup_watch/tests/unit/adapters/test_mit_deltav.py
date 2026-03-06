from startup_watch.adapters.mit_deltav import MitDeltavAdapter


class _Resp:
    def __init__(self, code: int, text: str):
        self.status_code = code
        self.text = text


def test_fetch_returns_list(monkeypatch) -> None:
    def _get(*args, **kwargs):
        return _Resp(200, "<h2>Acme Robotics</h2>")

    monkeypatch.setattr("startup_watch.adapters.mit_deltav.requests.get", _get)
    adapter = MitDeltavAdapter({"enabled": True, "urls": ["https://example.com"]})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_404(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.mit_deltav.requests.get", lambda *a, **k: _Resp(404, ""))
    adapter = MitDeltavAdapter({"enabled": True, "urls": ["https://example.com"]})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.mit_deltav.requests.get", lambda *a, **k: _Resp(200, "<h3>Beta Labs</h3>"))
    adapter = MitDeltavAdapter({"enabled": True, "urls": ["https://example.com"]})
    signals = adapter.fetch()
    assert signals
    assert signals[0].company_name
    assert signals[0].source_name == "mit_deltav"
