from types import SimpleNamespace

from startup_watch.adapters.climateinsider import ClimateinsiderAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="Climate startup", link="https://example.com/c", summary="summary")])


def test_climateinsider_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.climateinsider.feedparser.parse", lambda _url: _fake_feed())
    adapter = ClimateinsiderAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "climateinsider"
