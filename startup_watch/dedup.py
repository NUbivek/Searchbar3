from startup_watch.schema import StartupSignal


def deduplicate_signals(signals: list[StartupSignal]) -> list[StartupSignal]:
    seen: dict[str, StartupSignal] = {}
    for signal in signals:
        key = "".join(ch for ch in signal.company_name.lower() if ch.isalnum())
        if not key:
            key = signal.website.lower()
        if not key:
            key = f"{signal.source_name}:{signal.source_url}:{signal.description[:40]}"
        if key not in seen:
            seen[key] = signal
    return list(seen.values())
