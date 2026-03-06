from startup_watch.dedup import deduplicate_signals
from startup_watch.schema import StartupSignal


def test_deduplicate_signals() -> None:
    signals = [StartupSignal(company_name="Acme"), StartupSignal(company_name="Acme")]
    result = deduplicate_signals(signals)
    assert len(result) == 1
