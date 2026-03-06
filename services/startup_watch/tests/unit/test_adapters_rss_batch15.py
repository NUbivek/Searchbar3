from types import SimpleNamespace

from startup_watch.adapters.euvc import EuvcAdapter
from startup_watch.adapters.sifted_news import SiftedNewsAdapter
from startup_watch.adapters.unicornnest import UnicornnestAdapter


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


def test_euvc_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.euvc.feedparser.parse", lambda _url: _fake_feed())
    adapter = EuvcAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "euvc"


def test_sifted_news_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.sifted_news.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiftedNewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "sifted_news"


def test_unicornnest_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.unicornnest.feedparser.parse", lambda _url: _fake_feed())
    adapter = UnicornnestAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "unicornnest"
