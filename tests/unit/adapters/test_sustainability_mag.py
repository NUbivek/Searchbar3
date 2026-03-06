from types import SimpleNamespace

from startup_watch.adapters.sustainability_mag import SustainabilityMagAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="Sustainability startup", link="https://example.com/b", summary="summary")])


def test_sustainability_mag_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.sustainability_mag.feedparser.parse", lambda _url: _fake_feed())
    adapter = SustainabilityMagAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "sustainability_mag"
