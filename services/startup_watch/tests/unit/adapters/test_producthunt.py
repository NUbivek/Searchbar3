from startup_watch.adapters.producthunt import ProducthuntAdapter


class _Feed:
    def __init__(self, entries):
        self.entries = entries


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.producthunt.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Prod", "link": "u", "summary": "s"})()]),
    )
    adapter = ProducthuntAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_error(monkeypatch) -> None:
    def _boom(*args, **kwargs):
        raise RuntimeError("x")

    monkeypatch.setattr("startup_watch.adapters.producthunt.feedparser.parse", _boom)
    adapter = ProducthuntAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.producthunt.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Prod2", "link": "u", "summary": "s"})()]),
    )
    adapter = ProducthuntAdapter({"enabled": True, "url": "https://example.com/feed"})
    result = adapter.fetch()
    assert result and result[0].company_name
