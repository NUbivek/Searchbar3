from startup_watch.adapters.agfunder import AgfunderAdapter


class _Resp:
    def __init__(self, code: int, text: str):
        self.status_code = code
        self.text = text


def test_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.agfunder.requests.get", lambda *a, **k: _Resp(200, "<h2>FarmOps</h2>"))
    adapter = AgfunderAdapter({"enabled": True, "url": "https://example.com"})
    signals = adapter.fetch()
    assert signals and signals[0].source_name == "agfunder"
