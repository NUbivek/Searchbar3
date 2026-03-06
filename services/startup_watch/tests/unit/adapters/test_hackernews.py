from types import SimpleNamespace

from startup_watch.adapters.hackernews import HackernewsAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(entries=[SimpleNamespace(title="HN launch", link="https://example.com/hn", summary="maker launch")])


def test_hackernews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.hackernews.feedparser.parse", lambda _url: _fake_feed())
    adapter = HackernewsAdapter({"enabled": True, "url": "https://example.com/feed"})
    signals = adapter.fetch()
    assert len(signals) == 1
    assert signals[0].source_name == "hackernews"
