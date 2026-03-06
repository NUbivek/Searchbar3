from types import SimpleNamespace

from startup_watch.adapters.iiot_world import IiotWorldAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example IIoT startup raises seed",
                link="https://example.com/iiot",
                summary="Manufacturing analytics platform secures financing.",
            )
        ]
    )


def test_iiot_world_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr(
        "startup_watch.adapters.iiot_world.feedparser.parse", lambda _url: _fake_feed()
    )
    adapter = IiotWorldAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "iiot_world"
