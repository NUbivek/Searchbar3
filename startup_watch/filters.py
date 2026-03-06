from startup_watch.schema import StartupSignal


def filter_by_category(signals: list[StartupSignal], categories: list[str]) -> list[StartupSignal]:
    wanted = {c.lower().strip() for c in categories}
    if not wanted:
        return signals
    out: list[StartupSignal] = []
    for signal in signals:
        signal_cats = {c.lower().strip() for c in signal.categories}
        if signal_cats.intersection(wanted):
            out.append(signal)
    return out


def filter_by_stage(signals: list[StartupSignal], stages: list[str]) -> list[StartupSignal]:
    allowed = {s.lower().strip() for s in stages}
    if not allowed:
        return signals
    return [s for s in signals if s.stage.lower().strip() in allowed]


def filter_excluded(
    signals: list[StartupSignal], excluded_companies: list[str]
) -> list[StartupSignal]:
    excluded = [x.lower().strip() for x in excluded_companies]
    if not excluded:
        return signals
    return [s for s in signals if not any(x in s.company_name.lower() for x in excluded)]
