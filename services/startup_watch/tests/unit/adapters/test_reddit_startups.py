from types import SimpleNamespace

from startup_watch.adapters.reddit_startups import RedditStartupsAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="Startup post", link="https://example.com/r", summary="new startup")])


def test_reddit_startups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.reddit_startups.feedparser.parse", lambda _url: _fake_feed())
    adapter = RedditStartupsAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "reddit_startups"
