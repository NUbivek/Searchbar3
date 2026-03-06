install:
	python3 -m pip install -r requirements-dev.txt

run-ci:
	python startup_watch/startup_watch.py --config startup_watch/config.github.yaml

run-local:
	python startup_watch/startup_watch.py --config startup_watch/config.yaml

test:
	python -m pytest tests/ -q

lint:
	python -m flake8 startup_watch/ --max-line-length=100
