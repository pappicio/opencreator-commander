#!/usr/bin/env python3
"""OpenCreator Commander: LAN-restricted file manager and SSH-account PTY."""
import re
import base64, fcntl, grp, hashlib, hmac, ipaddress, json, mimetypes
import os, pwd, pty, select, shutil, signal, socket, struct, subprocess
import termios, threading, time, urllib.parse, uuid, ctypes
from contextlib import contextmanager

LIBCRYPT = ctypes.CDLL("libcrypt.so.1")
LIBCRYPT.crypt.argtypes = (ctypes.c_char_p, ctypes.c_char_p)
LIBCRYPT.crypt.restype = ctypes.c_char_p

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "www")
CONFIG_PATH = "/usr/data/opencreator/commander/config.json"
SETTINGS_PATH = "/usr/data/opencreator/commander/settings.json"
LOG_PATH = "/tmp/opencreator-commander.log"
MAX_UPLOAD = 512 * 1024 * 1024
MAX_EDIT = 2 * 1024 * 1024
SESSION_TTL = 30 * 60
# Same LAN allow-list pattern used by the other Creator 5 web services.
ALLOWED_IPS = {"127.0.0.1", "192.168.1.194", "192.168.1.197"}
ALLOWED_NETWORKS = [ipaddress.ip_network("127.0.0.0/8"), ipaddress.ip_network("192.168.1.0/24")]

_sessions = {}
_sessions_lock = threading.RLock()
_fs_lock = threading.RLock()
_libc = ctypes.CDLL(None, use_errno=True)


def log(message):
    try:
        with open(LOG_PATH, "a") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
    except Exception:
        pass


def load_config():
    try:
        with open(CONFIG_PATH, "r") as f:
            cfg = json.load(f)
        return {"port": int(cfg.get("port", 8766))}
    except Exception as exc:
        raise RuntimeError("Commander is not configured; run install.sh first: %s" % exc)


CONFIG = load_config()
PORT = CONFIG["port"]


def safe_path(value):
    value = urllib.parse.unquote(str(value or "/"))
    if not value.startswith("/"):
        value = "/" + value
    return os.path.abspath(os.path.normpath(value))


PROTECTION_PATH = "/usr/data/opencreator/commander/protected.json"
PERMANENT_ROOT = os.path.realpath("/usr/prog")
PERMANENT_FILE = os.path.realpath("/usr/prog/app_startup.sh")
_protection_lock = threading.RLock()


def _is_inside(path, root):
    try:
        return os.path.commonpath((path, root)) == root
    except (ValueError, OSError):
        return False


def _canonical(path):
    return os.path.realpath(safe_path(path))


def _load_protections():
    try:
        with open(PROTECTION_PATH, "r") as f:
            values = json.load(f)
        if not isinstance(values, list):
            return set()
        return {_canonical(x) for x in values if isinstance(x, str) and x}
    except (OSError, ValueError, TypeError):
        return set()


_CUSTOM_PROTECTIONS = _load_protections()


def _save_protections():
    old_uid = _libc.setfsuid(ctypes.c_uint(0))
    temp = PROTECTION_PATH + ".tmp-" + uuid.uuid4().hex
    try:
        with open(temp, "w") as f:
            json.dump(sorted(_CUSTOM_PROTECTIONS), f, indent=2)
            f.write("\n")
        os.chmod(temp, 0o600)
        os.replace(temp, PROTECTION_PATH)
    finally:
        try:
            os.unlink(temp)
        except OSError:
            pass
        _libc.setfsuid(ctypes.c_uint(old_uid))


def protection_info(path):
    target = _canonical(path)
    permanent_file = target == PERMANENT_FILE
    matching_root = next((root for root in _CUSTOM_PROTECTIONS if _is_inside(target, root)), None)
    custom = matching_root is not None
    return {
        "protected": permanent_file or custom,
        "permanent": permanent_file,
        "system": permanent_file,
        "custom": custom,
        "custom_root": matching_root == target,
    }


def ensure_mutable(path, include_ancestors=False):
    target = _canonical(path)

    if target == PERMANENT_FILE:
        raise PermissionError("This system file is permanently protected")
    if include_ancestors and _is_inside(PERMANENT_FILE, target):
        raise PermissionError("This operation would affect a permanently protected system file")

    for root in _CUSTOM_PROTECTIONS:
        if _is_inside(target, root):
            raise PermissionError("This path is protected in OpenCreator Commander")
        if include_ancestors and _is_inside(root, target):
            raise PermissionError("This operation would affect a protected path")


def set_custom_protection(path, enabled):
    target = _canonical(path)
    if target == "/":
        raise ValueError("The filesystem root cannot be protected")
    if target == PERMANENT_FILE:
        raise PermissionError("This system file is permanently protected")

    with _protection_lock:
        if enabled:
            _CUSTOM_PROTECTIONS.add(target)
        else:
            _CUSTOM_PROTECTIONS.discard(target)
        _save_protections()


def cookie_value(header, name):
    for item in (header or "").split(";"):
        if "=" in item:
            key, value = item.strip().split("=", 1)
            if key == name:
                return value
    return ""


def verify_credentials(username, password):
    """Verify a local Linux account password against /etc/shadow."""
    if not username or len(username) > 64 or not password or len(password) > 1024:
        return None
    try:
        account = pwd.getpwnam(username)
        if account.pw_uid < 0 or account.pw_shell in ("/sbin/nologin", "/usr/sbin/nologin", "/bin/false"):
            return None
        shadow_hash = None
        shadow_entry_found = False

        try:
            with open("/etc/shadow", "r") as f:
                for line in f:
                    fields = line.rstrip("\n").split(":")
                    if fields and fields[0] == username and len(fields) > 1:
                        shadow_hash = fields[1]
                        shadow_entry_found = True
                        break
        except OSError:
            pass

        # Some embedded firmware stores password hashes directly in /etc/passwd.
        if not shadow_entry_found:
            shadow_hash = account.pw_passwd

        if not shadow_hash or shadow_hash.startswith(("!", "*", "x")):
            return None
        candidate = LIBCRYPT.crypt(password.encode(), shadow_hash.encode())
        if not candidate or not hmac.compare_digest(candidate.decode(), shadow_hash):
            return None
        return account
    except (KeyError, OSError, ValueError, TypeError):
        return None


@contextmanager
def as_user(username):
    """Apply the authenticated account's filesystem credentials to this request thread."""
    account = pwd.getpwnam(username)
    if os.geteuid() != 0:
        if account.pw_uid != os.geteuid():
            raise PermissionError("Commander must run as root to access files as other SSH users")
        yield
        return
    groups = os.getgroups()
    old_gid = os.getegid()
    old_uid = os.geteuid()
    with _fs_lock:
        try:
            os.setgroups(os.getgrouplist(username, account.pw_gid))
            _libc.setfsgid(ctypes.c_uint(account.pw_gid))
            _libc.setfsuid(ctypes.c_uint(account.pw_uid))
            yield
        finally:
            _libc.setfsuid(ctypes.c_uint(old_uid))
            _libc.setfsgid(ctypes.c_uint(old_gid))
            os.setgroups(groups)


def get_session(header):
    token = cookie_value(header, "oc_commander")
    if not token:
        return None
    now = time.time()
    with _sessions_lock:
        session = _sessions.get(token)
        if not session:
            return None
        if now - session["last"] > SESSION_TTL:
            _sessions.pop(token, None)
            return None
        session["last"] = now
        return session["username"]


def ws_send(sock, payload, opcode=1):
    if isinstance(payload, str):
        payload = payload.encode("utf-8", "replace")
    length = len(payload)
    head = bytearray([0x80 | opcode])
    if length < 126:
        head.append(length)
    elif length < 65536:
        head.append(126); head.extend(struct.pack("!H", length))
    else:
        head.append(127); head.extend(struct.pack("!Q", length))
    sock.sendall(bytes(head) + payload)


def ws_recv(sock):
    def exact(n):
        data = b""
        while len(data) < n:
            chunk = sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("websocket closed")
            data += chunk
        return data
    first, second = exact(2)
    opcode, length = first & 0x0F, second & 0x7F
    masked = bool(second & 0x80)
    if length == 126: length = struct.unpack("!H", exact(2))[0]
    elif length == 127: length = struct.unpack("!Q", exact(8))[0]
    if length > 1024 * 1024: raise ValueError("websocket frame too large")
    mask = exact(4) if masked else b""
    data = exact(length) if length else b""
    if masked: data = bytes(v ^ mask[i % 4] for i, v in enumerate(data))
    return opcode, data


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenCreatorCommander/0.2"

    def log_message(self, fmt, *args):
        log(fmt % args)

    def parse_request(self):
        if not super().parse_request():
            return False
        try:
            addr = ipaddress.ip_address(self.client_address[0].split("%", 1)[0])
            allowed = self.client_address[0] in ALLOWED_IPS or any(addr in net for net in ALLOWED_NETWORKS)
        except ValueError:
            allowed = False
        if not allowed:
            self.send_error(403, "LAN access only")
            log("blocked non-LAN client %s" % self.client_address[0])
            return False
        return True

    def send_json(self, status, value, headers=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        if headers:
            for key, val in headers.items(): self.send_header(key, val)
        self.end_headers(); self.wfile.write(body)

    def read_body(self, limit=MAX_UPLOAD):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > limit: raise ValueError("Request body too large")
        return self.rfile.read(length)

    def username(self):
        return get_session(self.headers.get("Cookie"))

    def require_auth(self):
        user = self.username()
        if not user:
            self.send_json(401, {"error": "SSH login required"})
            return None
        return user

    def check_origin(self):
        origin = self.headers.get("Origin")
        if not origin: return True
        try:
            return urllib.parse.urlparse(origin).netloc.lower() == self.headers.get("Host", "").lower()
        except Exception:
            return False

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path); path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if path in ("/", "/index.html"): return self.serve_static("index.html")
        if path == "/app.js": return self.serve_static("app.js")
        if path == "/style.css": return self.serve_static("style.css")
        if path == "/api/health": return self.send_json(200, {"name": "OpenCreator Commander", "version": "0.2.0"})
        if path == "/api/session":
            user = self.require_auth()
            if user: return self.send_json(200, {"ok": True, "username": user})
            return
        if path == "/ws/terminal": return self.handle_terminal_ws()
        user = self.require_auth()
        if not user: return
        if path == "/api/settings":
            defaults = {
                "color_rw": "#91a0b2",
                "color_ro": "#ffb15c",
                "color_system": "#ff9f43",
                "font_base": 16,
                "font_labels": 14,
                "font_buttons": 16,
            }
            try:
                with open(SETTINGS_PATH, "r") as f:
                    stored = json.load(f)
                if isinstance(stored, dict):
                    defaults.update({k: v for k, v in stored.items() if k in defaults})
            except (OSError, ValueError, TypeError):
                pass
            return self.send_json(200, {"settings": defaults})
        if path == "/api/editor-window":
            try:
                config_path = "/usr/data/opencreator/commander/editor-window.json"
                with open(config_path, "r") as f:
                    geometry = json.load(f)
                return self.send_json(200, {"geometry": geometry})
            except (OSError, ValueError, TypeError):
                return self.send_json(200, {"geometry": None})
        try:
            with as_user(user):
                if path == "/api/fs/list": return self.fs_list(query.get("path", ["/"])[0])
                if path == "/api/fs/download": return self.fs_download(query.get("path", [""])[0])
                if path == "/api/fs/read": return self.fs_read(query.get("path", [""])[0])
        except Exception as exc: return self.send_json(403, {"error": str(exc)})
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self.check_origin(): return self.send_json(403, {"error": "Invalid request origin"})
        if parsed.path == "/api/login":
            try:
                data = json.loads(self.read_body(8192).decode("utf-8"))
                username, password = str(data.get("username", "")), str(data.get("password", ""))
            except Exception: return self.send_json(400, {"error": "Invalid request"})
            account = verify_credentials(username, password)
            if not account:
                time.sleep(0.5)
                log("failed login from %s for user %s" % (self.client_address[0], username[:64]))
                return self.send_json(401, {"error": "Invalid SSH username or password"})
            token = uuid.uuid4().hex + uuid.uuid4().hex
            with _sessions_lock: _sessions[token] = {"username": username, "last": time.time()}
            log("login accepted from %s as %s" % (self.client_address[0], username))
            return self.send_json(200, {"ok": True, "username": username}, {
                "Set-Cookie": "oc_commander=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d" % (token, SESSION_TTL)
            })
        if parsed.path == "/api/logout":
            token = cookie_value(self.headers.get("Cookie"), "oc_commander")
            with _sessions_lock: _sessions.pop(token, None)
            return self.send_json(200, {"ok": True}, {"Set-Cookie": "oc_commander=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"})
        user = self.require_auth()
        if not user: return
        try:
            data = json.loads(self.read_body(1024 * 1024).decode("utf-8"))

            if parsed.path == "/api/settings":
                defaults = {
                    "color_rw": "#91a0b2",
                    "color_ro": "#ffb15c",
                    "color_system": "#ff9f43",
                    "font_base": 16,
                    "font_labels": 14,
                    "font_buttons": 16,
                }
                settings = {}
                for key in ("color_rw", "color_ro", "color_system"):
                    value = str(data.get(key, defaults[key]))
                    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                        raise ValueError("Invalid color value")
                    settings[key] = value
                for key in ("font_base", "font_labels", "font_buttons"):
                    value = int(data.get(key, defaults[key]))
                    if not 12 <= value <= 24:
                        raise ValueError("Font size must be between 12 and 24")
                    settings[key] = value

                temp_path = SETTINGS_PATH + ".tmp"
                with open(temp_path, "w") as f:
                    json.dump(settings, f, indent=2)
                    f.write("\n")
                os.chmod(temp_path, 0o600)
                os.replace(temp_path, SETTINGS_PATH)
                return self.send_json(200, {"ok": True, "settings": settings})

            if parsed.path == "/api/editor-window":
                geometry = data.get("geometry")
                if not isinstance(geometry, dict):
                    raise ValueError("Invalid editor window geometry")

                values = {}
                for key in ("x", "y", "width", "height"):
                    value = float(geometry[key])
                    if not (-10000 <= value <= 10000):
                        raise ValueError("Editor window geometry out of range")
                    values[key] = round(value)

                if values["width"] < 420 or values["height"] < 300:
                    raise ValueError("Editor window is too small")

                config_path = "/usr/data/opencreator/commander/editor-window.json"
                temp_path = config_path + ".tmp"
                with open(temp_path, "w") as f:
                    json.dump(values, f)
                    f.write("\n")
                os.chmod(temp_path, 0o600)
                os.replace(temp_path, config_path)
                return self.send_json(200, {"ok": True})

            if parsed.path in ("/api/fs/protect", "/api/fs/unprotect"):
                target = data.get("path", "")
                if not target:
                    raise ValueError("Missing path")
                set_custom_protection(target, parsed.path == "/api/fs/protect")
                return self.send_json(200, {"ok": True, "protection": protection_info(target)})

            with as_user(user):
                if parsed.path == "/api/fs/mkdir":
                    parent = safe_path(data.get("path", "/")); name = os.path.basename(str(data.get("name", "")))
                    if not name or name in (".", ".."): raise ValueError("Invalid directory name")
                    ensure_mutable(parent)
                    ensure_mutable(os.path.join(parent, name))
                    os.mkdir(os.path.join(parent, name)); return self.send_json(200, {"ok": True})
                if parsed.path == "/api/fs/rename":
                    source = safe_path(data.get("path", "")); name = os.path.basename(str(data.get("name", "")))
                    if not name or name in (".", ".."): raise ValueError("Invalid name")
                    destination = os.path.join(os.path.dirname(source), name)
                    ensure_mutable(source, include_ancestors=True)
                    ensure_mutable(destination)
                    os.rename(source, destination); return self.send_json(200, {"ok": True})
                if parsed.path == "/api/fs/delete":
                    target = safe_path(data.get("path", ""))
                    if target == "/": raise ValueError("Refusing to delete filesystem root")
                    ensure_mutable(target, include_ancestors=True)
                    if os.path.isdir(target) and not os.path.islink(target): shutil.rmtree(target)
                    else: os.unlink(target)
                    return self.send_json(200, {"ok": True})
                if parsed.path == "/api/fs/move":
                    source = safe_path(data.get("source", "")); dest = safe_path(data.get("destination", "/"))
                    destination = os.path.join(dest, os.path.basename(source))
                    ensure_mutable(source, include_ancestors=True)
                    ensure_mutable(dest)
                    ensure_mutable(destination)
                    os.rename(source, destination); return self.send_json(200, {"ok": True})
                if parsed.path == "/api/fs/chmod":
                    target = safe_path(data.get("path", "")); mode = int(str(data.get("mode", "644")), 8)
                    ensure_mutable(target, include_ancestors=True)
                    os.chmod(target, mode); return self.send_json(200, {"ok": True})
        except Exception as exc: return self.send_json(400, {"error": str(exc)})
        self.send_json(404, {"error": "Not found"})

    def do_PUT(self):
        if not self.check_origin(): return self.send_json(403, {"error": "Invalid request origin"})
        user = self.require_auth()
        if not user: return
        parsed = urllib.parse.urlparse(self.path); query = urllib.parse.parse_qs(parsed.query)
        try:
            with as_user(user):
                if parsed.path == "/api/fs/upload":
                    directory = safe_path(query.get("dir", ["/"])[0]); name = os.path.basename(query.get("name", [""])[0])
                    if not name or name in (".", ".."): raise ValueError("Invalid filename")
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 0 or length > MAX_UPLOAD: raise ValueError("Upload exceeds the 512 MB limit")
                    destination = os.path.join(directory, name)
                    ensure_mutable(directory)
                    ensure_mutable(destination)
                    temp = destination + ".oc-upload-" + uuid.uuid4().hex
                    remaining = length
                    try:
                        with open(temp, "wb") as f:
                            while remaining:
                                chunk = self.rfile.read(min(65536, remaining))
                                if not chunk: raise IOError("Incomplete upload")
                                f.write(chunk); remaining -= len(chunk)
                        os.replace(temp, destination)
                    except Exception:
                        try: os.unlink(temp)
                        except OSError: pass
                        raise
                    return self.send_json(200, {"ok": True, "size": length})
                if parsed.path == "/api/fs/write":
                    target = safe_path(query.get("path", [""])[0]); body = self.read_body(MAX_EDIT).decode("utf-8")
                    ensure_mutable(target, include_ancestors=True)
                    with open(target, "w", encoding="utf-8") as f: f.write(body)
                    return self.send_json(200, {"ok": True})
        except Exception as exc: return self.send_json(400, {"error": str(exc)})
        self.send_json(404, {"error": "Not found"})

    def serve_static(self, filename):
        path = os.path.join(WEB_DIR, filename)
        try:
            with open(path, "rb") as f: body = f.read()
        except OSError: return self.send_error(404)
        content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") or "javascript" in content_type else ""))
        self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff"); self.send_header("X-Frame-Options", "DENY")
        self.end_headers(); self.wfile.write(body)

    def fs_list(self, raw_path):
        path = safe_path(raw_path); names = os.listdir(path); items = []
        for name in names:
            full = os.path.join(path, name)
            try:
                st = os.lstat(full); link = os.path.islink(full); directory = os.path.isdir(full)
                info = protection_info(full)
                items.append({"name": name, "path": full, "type": "symlink" if link else ("directory" if directory else "file"), "size": int(st.st_size), "mtime": int(st.st_mtime), "mode": format(st.st_mode & 0o777, "04o"), **info})
            except OSError: continue
        items.sort(key=lambda x: (x["type"] != "directory", x["name"].lower()))
        return self.send_json(200, {"path": path, "parent": os.path.dirname(path.rstrip("/")) or "/", "items": items, "protection": protection_info(path)})

    def fs_download(self, raw_path):
        path = safe_path(raw_path)
        if not os.path.isfile(path): return self.send_json(400, {"error": "Not a regular file"})
        size = os.path.getsize(path); name = os.path.basename(path).replace('"', "")
        self.send_response(200); self.send_header("Content-Type", "application/octet-stream"); self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(name)); self.end_headers()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk: break
                self.wfile.write(chunk)

    def fs_read(self, raw_path):
        path = safe_path(raw_path)
        if os.path.getsize(path) > MAX_EDIT: return self.send_json(400, {"error": "File is larger than the 2 MB editor limit"})
        with open(path, "r", encoding="utf-8") as f: return self.send_json(200, {"path": path, "content": f.read(), "protection": protection_info(path)})

    def handle_terminal_ws(self):
        username = self.username()
        if not username: return self.send_error(401)
        if not self.check_origin(): return self.send_error(403, "Invalid WebSocket origin")
        if self.headers.get("Upgrade", "").lower() != "websocket": return self.send_error(400)
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key: return self.send_error(400)
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101, "Switching Protocols"); self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade"); self.send_header("Sec-WebSocket-Accept", accept); self.end_headers(); self.wfile.flush()
        sock = self.connection; sock.settimeout(0.15); pid = master = None
        try:
            account = pwd.getpwnam(username)
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            cwd_value = query.get("cwd", [account.pw_dir or "/"])[0]
            requested_cwd = os.path.abspath(os.path.normpath(cwd_value if cwd_value.startswith("/") else "/" + cwd_value))
            pid, master = pty.fork()
            if pid == 0:
                try:
                    os.initgroups(username, account.pw_gid); os.setgid(account.pw_gid); os.setuid(account.pw_uid)
                    try:
                        os.chdir(requested_cwd)
                    except OSError:
                        os.chdir(account.pw_dir or "/")
                    env = os.environ.copy(); env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "HOME": account.pw_dir, "USER": username, "LOGNAME": username})
                    shell = account.pw_shell if account.pw_shell and os.path.isfile(account.pw_shell) else "/bin/sh"
                    os.execvpe(shell, [shell, "-i"], env)
                except Exception:
                    os._exit(127)
            log("terminal session started user=%s pid=%s" % (username, pid))
            while True:
                readable, _, _ = select.select([sock, master], [], [], 0.15)
                if master in readable:
                    try:
                        output = os.read(master, 65536)
                        if not output: break
                        ws_send(sock, output, 2)
                    except OSError: break
                if sock in readable:
                    try: opcode, data = ws_recv(sock)
                    except socket.timeout: continue
                    except Exception: break
                    if opcode == 8: break
                    if opcode in (1, 2):
                        try:
                            text = data.decode("utf-8")
                            if text.startswith('{"type":"resize"'):
                                msg = json.loads(text); rows = max(5, min(200, int(msg.get("rows", 24)))); cols = max(20, min(400, int(msg.get("cols", 80))))
                                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                            else: os.write(master, data)
                        except (UnicodeDecodeError, ValueError): os.write(master, data)
                        except Exception: pass
                try:
                    ended, _ = os.waitpid(pid, os.WNOHANG)
                    if ended: break
                except ChildProcessError: break
        except Exception as exc: log("terminal error: %s" % exc)
        finally:
            if master is not None:
                try: os.close(master)
                except OSError: pass
            if pid:
                try: os.killpg(pid, signal.SIGHUP)
                except OSError:
                    try: os.kill(pid, signal.SIGHUP)
                    except OSError: pass
                try: os.waitpid(pid, os.WNOHANG)
                except Exception: pass
            log("terminal session closed user=%s" % username)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise SystemExit("OpenCreator Commander must run as root to validate SSH accounts and apply per-user file permissions")
    log("starting on 0.0.0.0:%d; LAN allow-list enabled" % PORT)
    server = Server(("0.0.0.0", PORT), Handler)
    try: server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt: pass
    finally: server.server_close()
