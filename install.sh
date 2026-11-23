#!/opt/bin/sh
set -eu

BASE="/usr/data/opencreator/commander"
CONFIG="$BASE/config.json"
PYTHON="/usr/data/python-hf/bin/python3"
[ -x "$PYTHON" ] || PYTHON="/usr/prog/Python-3.8.2/bin/python3"

mkdir -p "$BASE"
chmod 700 "$BASE"
if [ ! -f "$CONFIG" ]; then
    printf '{"port":8766}\n' > "$CONFIG"
    chmod 600 "$CONFIG"
fi
chmod +x "$(dirname "$0")/bin/commander.sh"
echo "OpenCreator Commander installed. Sign in with a local Creator 5 SSH username and password."
echo "LAN access is restricted to 192.168.1.0/24 and loopback."
