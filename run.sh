#!/usr/bin/env bash
# Start the dashboard. Extra arguments are passed on, e.g.  ./run.sh --config demo.yaml
cd "$(dirname "$0")"
exec venv/bin/python -m app.main "$@"
