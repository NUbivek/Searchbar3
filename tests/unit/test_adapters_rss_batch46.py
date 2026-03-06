from types import SimpleNamespace

from startup_watch.adapters.bothsidesofthetable import BothsidesofthetableAdapter
from startup_watch.adapters.avc_blog import AvcBlogAdapter
from startup_watch.adapters.feldthoughts import FeldthoughtsAdapter
from startup_watch.adapters.saastr_blog import SaastrBlogAdapter
from startup_watch.adapters.tomtunguz import TomtunguzAdapter


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


def test_bothsidesofthetable_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.bothsidesofthetable.feedparser.parse", lambda _url: _fake_feed())
    adapter = BothsidesofthetableAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "bothsidesofthetable"

def test_avc_blog_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.avc_blog.feedparser.parse", lambda _url: _fake_feed())
    adapter = AvcBlogAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "avc_blog"

def test_feldthoughts_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.feldthoughts.feedparser.parse", lambda _url: _fake_feed())
    adapter = FeldthoughtsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "feldthoughts"

def test_saastr_blog_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.saastr_blog.feedparser.parse", lambda _url: _fake_feed())
    adapter = SaastrBlogAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "saastr_blog"

def test_tomtunguz_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.tomtunguz.feedparser.parse", lambda _url: _fake_feed())
    adapter = TomtunguzAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "tomtunguz"
