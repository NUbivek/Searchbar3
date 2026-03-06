from dataclasses import dataclass, field
from datetime import datetime, timezone


CANONICAL_STAGES = {"pre-seed", "stealth", "seed", "series-a", "series-b", "series-c", "unknown"}


@dataclass
class StartupSignal:
    company_name: str = ""
    website: str = ""
    description: str = ""
    stage: str = "unknown"
    categories: list[str] = field(default_factory=list)
    source_name: str = ""
    source_url: str = ""
    scraped_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    founders: list[str] = field(default_factory=list)
    linkedin_url: str = ""
    location: str = ""
    funding_amount: str = ""
    investor_names: list[str] = field(default_factory=list)
    notes: str = ""
    headcount_range: str = ""
    total_raised: str = ""
    investor_tier: str = "unknown"

    def normalize(self) -> "StartupSignal":
        stage = (self.stage or "unknown").lower().strip()
        self.stage = stage if stage in CANONICAL_STAGES else "unknown"
        self.categories = [c.strip() for c in self.categories if c and c.strip()]
        return self
