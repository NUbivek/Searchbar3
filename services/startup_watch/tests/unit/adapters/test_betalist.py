from startup_watch.adapters.betalist import BetalistAdapter


class _Resp:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.betalist.requests.get",
        lambda *a, **k: _Resp(200, "<h2>BetaCo</h2>"),
    )
    adapter = BetalistAdapter({"enabled": True, "url": "https://example.com"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_404(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.betalist.requests.get",
        lambda *a, **k: _Resp(404, ""),
    )
    adapter = BetalistAdapter({"enabled": True, "url": "https://example.com"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.betalist.requests.get",
        lambda *a, **k: _Resp(200, "<h3>NewCo</h3>"),
    )
    adapter = BetalistAdapter({"enabled": True, "url": "https://example.com"})
    result = adapter.fetch()
    assert result and result[0].company_name
