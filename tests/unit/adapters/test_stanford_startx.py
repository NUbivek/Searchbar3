from startup_watch.adapters.stanford_startx import StanfordStartxAdapter


class _Resp:
    def __init__(self, code: int, text: str):
        self.status_code = code
        self.text = text


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.stanford_startx.requests.get",
        lambda *a, **k: _Resp(200, "<a>Nova Supply</a>"),
    )
    adapter = StanfordStartxAdapter({"enabled": True, "url": "https://example.com"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_404(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.stanford_startx.requests.get",
        lambda *a, **k: _Resp(404, ""),
    )
    adapter = StanfordStartxAdapter({"enabled": True, "url": "https://example.com"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.stanford_startx.requests.get",
        lambda *a, **k: _Resp(200, "<a>Forge AI</a>"),
    )
    adapter = StanfordStartxAdapter({"enabled": True, "url": "https://example.com"})
    signals = adapter.fetch()
    assert signals
    assert signals[0].company_name
    assert signals[0].source_name == "stanford_startx"
