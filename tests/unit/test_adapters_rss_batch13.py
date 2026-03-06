from types import SimpleNamespace

from startup_watch.adapters.siliconcanals import SiliconcanalsAdapter
from startup_watch.adapters.startupdaily import StartupdailyAdapter
from startup_watch.adapters.vestbee import VestbeeAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup raises round",
                link="https://example.com/funding",
                summary="Company building software for operations and logistics.",
            )
        ]
    )


def test_siliconcanals_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.siliconcanals.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiliconcanalsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "siliconcanals"


def test_vestbee_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.vestbee.feedparser.parse", lambda _url: _fake_feed())
    adapter = VestbeeAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "vestbee"


def test_startupdaily_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupdaily.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupdailyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupdaily"
