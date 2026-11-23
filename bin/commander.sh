#!/opt/bin/sh
BASE="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PYTHON="/usr/data/python-hf/bin/python3"
[ -x "$PYTHON" ] || PYTHON="/usr/prog/Python-3.8.2/bin/python3"
exec "$PYTHON" "$BASE/server.py"
