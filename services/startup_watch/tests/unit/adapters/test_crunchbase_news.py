from types import SimpleNamespace

from startup_watch.adapters.crunchbase_news import CrunchbaseNewsAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="CB funding", link="https://example.com/cb", summary="funding news")])


def test_crunchbase_news_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.crunchbase_news.feedparser.parse", lambda _url: _fake_feed()
    )
    adapter = CrunchbaseNewsAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "crunchbase_news"
