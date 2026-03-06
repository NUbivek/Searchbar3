from types import SimpleNamespace

from startup_watch.adapters.startupland import StartuplandAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="Launch", link="https://example.com/s", summary="sum")])


def test_startupland_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupland.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartuplandAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "startupland"
