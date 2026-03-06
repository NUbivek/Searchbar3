from types import SimpleNamespace

from startup_watch.adapters.tech_eu import TechEuAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="TechEU funding", link="https://example.com/eu", summary="funding")])


def test_tech_eu_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.tech_eu.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechEuAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "tech_eu"
