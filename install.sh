
#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Detect the active LAN interface and its IPv4 subnet.
DEFAULT_ROUTE="$(ip -4 route show default 2>/dev/null | head -n 1 || true)"

LAN_CIDR=""
if [ -n "$DEFAULT_ROUTE" ]; then
    LAN_IF="$(printf '%s\n' "$DEFAULT_ROUTE" | sed -n 's/.* dev \([^ ]*\).*/\1/p')"

    if [ -n "$LAN_IF" ]; then
        LAN_CIDR="$(ip -o -4 addr show dev "$LAN_IF" scope global 2>/dev/null |
            awk 'NR == 1 {print $4}')"
    fi
fi

if [ -z "$LAN_CIDR" ]; then
    echo "WARNING: Could not automatically detect the LAN IPv4 subnet."
    echo "LAN access restrictions must be configured manually."
else
    echo "Detected LAN subnet: $LAN_CIDR"
fi

chmod +x "$SCRIPT_DIR/bin/commander.sh"

echo "OpenCreator Commander installed."
echo "Sign in with a local Creator 5 SSH username and password."
echo "Allowed network: ${LAN_CIDR:-NOT DETECTED} and loopback."
