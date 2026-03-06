from types import SimpleNamespace

from startup_watch.adapters.openhubstartup import OpenhubstartupAdapter
from startup_watch.adapters.startuptalky import StartuptalkyAdapter
from startup_watch.adapters.yourtechtoday import YourtechtodayAdapter
from startup_watch.adapters.techsafariz import TechsafarizAdapter
from startup_watch.adapters.africatechdaily import AfricatechdailyAdapter
from startup_watch.adapters.startupnewszone import StartupnewszoneAdapter
from startup_watch.adapters.venturefounders import VenturefoundersAdapter
from startup_watch.adapters.newstartupmedia import NewstartupmediaAdapter
from startup_watch.adapters.seedfundnews import SeedfundnewsAdapter
from startup_watch.adapters.techpulsefounders import TechpulsefoundersAdapter


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


def test_openhubstartup_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.openhubstartup.feedparser.parse", lambda _url: _fake_feed())
    adapter = OpenhubstartupAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "openhubstartup"

def test_startuptalky_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startuptalky.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartuptalkyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startuptalky"

def test_yourtechtoday_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.yourtechtoday.feedparser.parse", lambda _url: _fake_feed())
    adapter = YourtechtodayAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "yourtechtoday"

def test_techsafariz_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techsafariz.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechsafarizAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techsafariz"

def test_africatechdaily_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.africatechdaily.feedparser.parse", lambda _url: _fake_feed())
    adapter = AfricatechdailyAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "africatechdaily"

def test_startupnewszone_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupnewszone.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupnewszoneAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupnewszone"

def test_venturefounders_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.venturefounders.feedparser.parse", lambda _url: _fake_feed())
    adapter = VenturefoundersAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "venturefounders"

def test_newstartupmedia_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.newstartupmedia.feedparser.parse", lambda _url: _fake_feed())
    adapter = NewstartupmediaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "newstartupmedia"

def test_seedfundnews_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.seedfundnews.feedparser.parse", lambda _url: _fake_feed())
    adapter = SeedfundnewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "seedfundnews"

def test_techpulsefounders_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techpulsefounders.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechpulsefoundersAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techpulsefounders"
