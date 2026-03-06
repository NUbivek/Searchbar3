from types import SimpleNamespace

from startup_watch.adapters.indiehackers import IndiehackersAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="IH startup", link="https://example.com/ih", summary="new startup")])


def test_indiehackers_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.indiehackers.feedparser.parse", lambda _url: _fake_feed())
    adapter = IndiehackersAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "indiehackers"
