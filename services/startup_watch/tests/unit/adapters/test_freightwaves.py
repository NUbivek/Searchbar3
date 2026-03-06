from startup_watch.adapters.freightwaves import FreightwavesAdapter


class _Feed:
    def __init__(self, entries):
        self.entries = entries


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.freightwaves.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Freight", "link": "u", "summary": "s"})()]),
    )
    adapter = FreightwavesAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_parse_error(monkeypatch) -> None:
    def _boom(*args, **kwargs):
        raise RuntimeError("x")

    monkeypatch.setattr("startup_watch.adapters.freightwaves.feedparser.parse", _boom)
    adapter = FreightwavesAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.freightwaves.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Port", "link": "u", "summary": "s"})()]),
    )
    adapter = FreightwavesAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert signals and signals[0].company_name
