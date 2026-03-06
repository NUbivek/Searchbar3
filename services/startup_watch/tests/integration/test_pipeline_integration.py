from startup_watch.pipeline import run_pipeline
from startup_watch.schema import StartupSignal


def test_run_pipeline_filters_dedups_and_normalizes(monkeypatch) -> None:
    sample = [
        StartupSignal(
            company_name="Acme Logistics",
            description="Seed company",
            stage="seed",
            categories=["logistics"],
            source_name="a",
            source_url="https://example.com/a",
        ),
        StartupSignal(
            company_name="Acme Logistics",
            description="Seed company duplicate",
            stage="seed",
            categories=["logistics"],
            source_name="b",
            source_url="https://example.com/b",
        ),
        StartupSignal(
            company_name="Other Co",
            description="Series B company",
            stage="series-b",
            categories=["fintech"],
            source_name="c",
            source_url="https://example.com/c",
        ),
    ]
    monkeypatch.setattr("startup_watch.pipeline.collect_signals", lambda _cfg: sample)

    config = {
        "filters": {"exclude_companies": ["Other Co"]},
        "categories": ["logistics"],
        "stages": ["seed"],
    }

    out = run_pipeline(config)

    assert len(out) == 1
    assert out[0].company_name == "Acme Logistics"
    assert out[0].stage == "seed"
