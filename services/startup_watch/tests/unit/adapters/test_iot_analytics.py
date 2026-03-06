from startup_watch.adapters.iot_analytics import IotAnalyticsAdapter


class _Feed:
    def __init__(self, entries):
        self.entries = entries


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.iot_analytics.feedparser.parse", lambda *a, **k: _Feed([type("E", (), {"title": "IoT", "summary": "s", "link": "u"})()]))
    assert isinstance(IotAnalyticsAdapter({"enabled": True, "url": "x"}).fetch(), list)


def test_fetch_handles_error(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.iot_analytics.feedparser.parse", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    assert IotAnalyticsAdapter({"enabled": True, "url": "x"}).fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.iot_analytics.feedparser.parse", lambda *a, **k: _Feed([type("E", (), {"title": "IoT2", "summary": "s", "link": "u"})()]))
    result = IotAnalyticsAdapter({"enabled": True, "url": "x"}).fetch()
    assert result and result[0].company_name
