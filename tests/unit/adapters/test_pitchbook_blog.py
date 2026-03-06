from types import SimpleNamespace

from startup_watch.adapters.pitchbook_blog import PitchbookBlogAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup funding round",
                link="https://example.com/funding",
                summary="Enterprise supply chain startup raises seed.",
            )
        ]
    )


def test_pitchbook_blog_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.pitchbook_blog.feedparser.parse", lambda _url: _fake_feed()
    )
    adapter = PitchbookBlogAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "pitchbook_blog"
