from startup_watch.adapters.spendmatters import SpendmattersAdapter


class _Feed:
    def __init__(self, entries):
        self.entries = entries


def test_fetch_returns_list(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.spendmatters.feedparser.parse", lambda *a, **k: _Feed([type("E", (), {"title": "Spend", "summary": "s", "link": "u"})()]))
    assert isinstance(SpendmattersAdapter({"enabled": True, "url": "x"}).fetch(), list)


def test_fetch_handles_error(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.spendmatters.feedparser.parse", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    assert SpendmattersAdapter({"enabled": True, "url": "x"}).fetch() == []


def test_signal_fields(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.spendmatters.feedparser.parse", lambda *a, **k: _Feed([type("E", (), {"title": "Spend2", "summary": "s", "link": "u"})()]))
    result = SpendmattersAdapter({"enabled": True, "url": "x"}).fetch()
    assert result and result[0].company_name
