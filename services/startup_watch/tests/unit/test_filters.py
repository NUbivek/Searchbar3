from startup_watch.filters import filter_by_category, filter_by_stage
from startup_watch.schema import StartupSignal


def test_filter_by_category() -> None:
    signals = [StartupSignal(company_name="A", categories=["agtech"]), StartupSignal(company_name="B", categories=["fintech"])]
    result = filter_by_category(signals, ["agtech"])
    assert len(result) == 1
    assert result[0].company_name == "A"


def test_filter_by_stage() -> None:
    signals = [StartupSignal(company_name="A", stage="seed"), StartupSignal(company_name="B", stage="series-a")]
    result = filter_by_stage(signals, ["seed"])
    assert len(result) == 1
    assert result[0].company_name == "A"
