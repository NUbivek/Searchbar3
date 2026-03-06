import argparse

from startup_watch.pipeline import load_config, run_pipeline, write_csv


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Path to YAML config")
    args = parser.parse_args()

    config = load_config(args.config)
    signals = run_pipeline(config)
    output_path = write_csv(signals, config.get("output_dir", "startup_watch/output"))
    print(f"Wrote {len(signals)} rows to {output_path}")


if __name__ == "__main__":
    main()
