from types import SimpleNamespace

from startup_watch.adapters.cleanenergywire import CleanenergywireAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="Energy startup", link="https://example.com/a", summary="summary")])


def test_cleanenergywire_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.cleanenergywire.feedparser.parse", lambda _url: _fake_feed())
    adapter = CleanenergywireAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "cleanenergywire"
