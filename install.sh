
#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Detect the active LAN interface and calculate its network address.
DEFAULT_ROUTE="$(ip -4 route show default 2>/dev/null | head -n 1 || true)"
LAN_CIDR=""

if [ -n "$DEFAULT_ROUTE" ]; then
    LAN_IF="$(printf '%s\n' "$DEFAULT_ROUTE" | sed -n 's/.* dev \([^ ]*\).*/\1/p')"

    if [ -n "$LAN_IF" ]; then
        LAN_CIDR="$(
            ip -o -4 addr show dev "$LAN_IF" scope global 2>/dev/null |
            awk '
            NR == 1 {
                split($4, a, "/")
                split(a[1], ip, ".")
                prefix = a[2]

                for (i = 1; i <= 4; i++) {
                    bits = prefix - (i - 1) * 8

                    if (bits >= 8) {
                        net[i] = ip[i]
                    } else if (bits <= 0) {
                        net[i] = 0
                    } else {
                        block = 2 ^ (8 - bits)
                        net[i] = int(ip[i] / block) * block
                    }
                }

                printf "%d.%d.%d.%d/%d\n", net[1], net[2], net[3], net[4], prefix
                exit
            }'
        )"
    fi
fi

if [ -z "$LAN_CIDR" ]; then
    echo "ERROR: Could not detect the LAN network."
    exit 1
fi

chmod +x "$SCRIPT_DIR/bin/commander.sh"

echo "OpenCreator Commander installed."
echo "Sign in with a local Creator 5 SSH username and password."
echo "Allowed network: $LAN_CIDR and loopback."
