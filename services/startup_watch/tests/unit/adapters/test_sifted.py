from types import SimpleNamespace

from startup_watch.adapters.sifted import SiftedAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example European startup raises round",
                link="https://example.com/item",
                summary="Industrial software startup expands operations.",
            )
        ]
    )


def test_sifted_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.sifted.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiftedAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "sifted"
