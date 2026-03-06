from types import SimpleNamespace

from startup_watch.adapters.e27 import E27Adapter
from startup_watch.adapters.geekwire import GeekwireAdapter
from startup_watch.adapters.thenextweb import ThenextwebAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup raises round",
                link="https://example.com/funding",
                summary="Company building AI software for industrial operations.",
            )
        ]
    )


def test_geekwire_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.geekwire.feedparser.parse", lambda _url: _fake_feed())
    adapter = GeekwireAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "geekwire"


def test_thenextweb_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.thenextweb.feedparser.parse", lambda _url: _fake_feed())
    adapter = ThenextwebAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "thenextweb"


def test_e27_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.e27.feedparser.parse", lambda _url: _fake_feed())
    adapter = E27Adapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "e27"
