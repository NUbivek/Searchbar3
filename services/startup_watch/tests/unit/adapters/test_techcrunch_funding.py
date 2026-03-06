from startup_watch.adapters.techcrunch_funding import TechcrunchFundingAdapter


class _Feed:
    def __init__(self, entries):
        self.entries = entries


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.techcrunch_funding.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Acme", "link": "u", "summary": "s"})()]),
    )
    adapter = TechcrunchFundingAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert isinstance(adapter.fetch(), list)


def test_fetch_handles_parse_error(monkeypatch) -> None:
    def _boom(*args, **kwargs):
        raise RuntimeError("x")

    monkeypatch.setattr("startup_watch.adapters.techcrunch_funding.feedparser.parse", _boom)
    adapter = TechcrunchFundingAdapter({"enabled": True, "url": "https://example.com/feed"})
    assert adapter.fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.techcrunch_funding.feedparser.parse",
        lambda *a, **k: _Feed([type("E", (), {"title": "Beta", "link": "u", "summary": "s"})()]),
    )
    adapter = TechcrunchFundingAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert signals and signals[0].company_name
