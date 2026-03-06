from startup_watch.adapters.atdc import AtdcAdapter


class _Resp:
    def __init__(self, code: int, text: str):
        self.status_code = code
        self.text = text


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.atdc.requests.get",
        lambda *a, **k: _Resp(200, "<h2>LinePilot</h2>"),
    )
    adapter = AtdcAdapter({"enabled": True, "url": "https://example.com"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_404(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.atdc.requests.get",
        lambda *a, **k: _Resp(404, ""),
    )
    adapter = AtdcAdapter({"enabled": True, "url": "https://example.com"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.atdc.requests.get",
        lambda *a, **k: _Resp(200, "<h3>PlantGrid</h3>"),
    )
    adapter = AtdcAdapter({"enabled": True, "url": "https://example.com"})
    signals = adapter.fetch()
    assert signals
    assert signals[0].company_name
    assert signals[0].source_name == "atdc"
