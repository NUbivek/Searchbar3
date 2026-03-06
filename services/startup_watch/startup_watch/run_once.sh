#!/bin/bash
set -euo pipefail

ROOT_DIR="/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data/startup_watch"

cd "$ROOT_DIR"

if [ -f ".venv/bin/activate" ]; then
  source ".venv/bin/activate"
fi

python "startup_watch.py" --config "config.yaml"
