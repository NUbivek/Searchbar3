from types import SimpleNamespace

from startup_watch.adapters.itnewsafrica import ItnewsafricaAdapter
from startup_watch.adapters.disfold_blog import DisfoldBlogAdapter
from startup_watch.adapters.startupradius import StartupradiusAdapter
from startup_watch.adapters.nextbigwhat import NextbigwhatAdapter
from startup_watch.adapters.techcircle import TechcircleAdapter


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


def test_itnewsafrica_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.itnewsafrica.feedparser.parse", lambda _url: _fake_feed())
    adapter = ItnewsafricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "itnewsafrica"

def test_disfold_blog_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.disfold_blog.feedparser.parse", lambda _url: _fake_feed())
    adapter = DisfoldBlogAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "disfold_blog"

def test_startupradius_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupradius.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupradiusAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupradius"

def test_nextbigwhat_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.nextbigwhat.feedparser.parse", lambda _url: _fake_feed())
    adapter = NextbigwhatAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "nextbigwhat"

def test_techcircle_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techcircle.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechcircleAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techcircle"
