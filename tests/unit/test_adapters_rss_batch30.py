from types import SimpleNamespace

from startup_watch.adapters.pandaily import PandailyAdapter
from startup_watch.adapters.vulcanpost import VulcanpostAdapter
from startup_watch.adapters.wamda import WamdaAdapter


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


def test_vulcanpost_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.vulcanpost.feedparser.parse", lambda _url: _fake_feed())
    adapter = VulcanpostAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "vulcanpost"


def test_pandaily_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.pandaily.feedparser.parse", lambda _url: _fake_feed())
    adapter = PandailyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "pandaily"


def test_wamda_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.wamda.feedparser.parse", lambda _url: _fake_feed())
    adapter = WamdaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "wamda"
