from types import SimpleNamespace

from startup_watch.adapters.agriinvestor import AgriinvestorAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example agtech startup raises series A",
                link="https://example.com/ag",
                summary="Farm tech platform securing growth capital.",
            )
        ]
    )


def test_agriinvestor_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.agriinvestor.feedparser.parse", lambda _url: _fake_feed()
    )
    adapter = AgriinvestorAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "agriinvestor"
