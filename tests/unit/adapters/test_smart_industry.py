from startup_watch.adapters.smart_industry import SmartIndustryAdapter


class _Feed:
    def __init__(self, entries):
        self.entries = entries


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.smart_industry.feedparser.parse", lambda *a, **k: _Feed([type("E", (), {"title": "Smart", "summary": "s", "link": "u"})()]))
    assert isinstance(SmartIndustryAdapter({"enabled": True, "url": "x"}).fetch(), list)


def test_fetch_handles_error(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.smart_industry.feedparser.parse", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    assert SmartIndustryAdapter({"enabled": True, "url": "x"}).fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.smart_industry.feedparser.parse", lambda *a, **k: _Feed([type("E", (), {"title": "Smart2", "summary": "s", "link": "u"})()]))
    result = SmartIndustryAdapter({"enabled": True, "url": "x"}).fetch()
    assert result and result[0].company_name
