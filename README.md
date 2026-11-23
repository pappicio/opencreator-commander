# OpenCreator Commander 0.2.0

Standalone OpenCreator plugin for the FlashForge Creator 5. Provides a browser file manager and an interactive terminal on the printer itself. It also runs in Tunneled mode because it does not depend on the External Host.

## Authentication

- Sign in with a **local Creator 5 Linux account username and password** (the same account credentials used for SSH password login).
- The backend verifies the local account password against `/etc/shadow`; it does not store credentials in its server configuration. This matches the local password used for SSH when sshd uses the system password database, but it does not invoke sshd/PAM.
- The terminal starts the account's configured login shell with that account's UID/GID and supplementary groups.
- File listing, upload, download, editing and file operations run with the authenticated account's filesystem permissions.
- Sessions use random HttpOnly cookies and expire after 30 minutes of inactivity.
- The login page can remember only the username, or username and password. If password saving is enabled, the browser explicitly warns that it stores the password unencrypted in that browser profile's local storage. Do not enable this on shared/untrusted computers.

**Note:** this validates local password credentials from `/etc/shadow`. Accounts configured for SSH key-only access or with a locked/disabled password cannot use password login here.

## LAN restriction

The HTTP server binds to `0.0.0.0` so LAN devices can reach it, but every request (including WebSocket terminal connections) is filtered server-side. The current allow-list permits loopback and `192.168.1.0/24`, matching the Creator 5 LAN configuration. Requests from other networks are rejected. No `X-Forwarded-For` header is trusted. Do not expose port `8766` through WAN port forwarding or a public reverse proxy. The service uses HTTP (not HTTPS), so use it only on a trusted LAN; do not use it over untrusted Wi-Fi.

If the printer's LAN subnet changes, update `ALLOWED_NETWORKS` in `server.py` before deployment.

## Install

Install the ZIP with the OpenCreator Plugin Manager or `oc-plugin install` using the plugin ZIP. The plugin manager runs `install.sh`, then starts `bin/commander.sh` as a service.

Open:

`http://<CREATOR-5-LAN-IP>:8766/`

The service must run as root so it can validate local shadow passwords and apply the authenticated account's filesystem credentials. It does **not** create an SSH server or require sshd to be enabled; it uses the local Linux account database and launches the account's shell directly.

## Features

- Full filesystem explorer, subject to the logged-in account's permissions.
- Drag-and-drop and multi-file upload (512 MB per file limit).
- Download, create folder, rename, move, delete and chmod.
- Text editor for files up to 2 MB.
- Interactive PTY terminal with ANSI colors, resize and multiple tabs.
- No dependency on Radxa/Raspberry/External Host.

## Runtime

- Port: `8766` (change `/usr/data/opencreator/commander/config.json`).
- Runtime config: `/usr/data/opencreator/commander/config.json`.
- Log: `/tmp/opencreator-commander.log`.
- Frontend terminal renderer currently loads xterm.js from a CDN, so the browser needs access to that CDN.

## Security notes

This is an administrative tool. Any authenticated account can access files and commands allowed to that account. The root account therefore has full printer access. Use strong account passwords, keep the service LAN-only, and do not save passwords in shared browser profiles.
