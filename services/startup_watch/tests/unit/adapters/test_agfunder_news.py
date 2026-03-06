from startup_watch.adapters.agfunder_news import AgfunderNewsAdapter


class _Feed:
    def __init__(self, entries):
        self.entries = entries


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.agfunder_news.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Farm", "link": "u", "summary": "s"})()]),
    )
    adapter = AgfunderNewsAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_parse_error(monkeypatch) -> None:
    def _boom(*args, **kwargs):
        raise RuntimeError("x")

    monkeypatch.setattr("startup_watch.adapters.agfunder_news.feedparser.parse", _boom)
    adapter = AgfunderNewsAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.agfunder_news.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Soil", "link": "u", "summary": "s"})()]),
    )
    adapter = AgfunderNewsAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert signals and signals[0].company_name
