#!/usr/bin/python3 -I
"""Validate an effective Servus Compose configuration and save a snapshot."""
import json, os, posixpath, re, sys
try:
    data_dir = sys.argv[3]
    if not data_dir.startswith("/") or data_dir == "/" or posixpath.normpath(data_dir) != data_dir: raise ValueError()
    protected = ("/app", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/proc", "/sys", "/run", "/var/run", "/tmp", "/root", "/home/node")
    def overlaps(left, right):
        return left == right or left.startswith(right + "/") or right.startswith(left + "/")
    if any(overlaps(data_dir, path) for path in protected): raise ValueError()
    if any(overlaps(data_dir, path) for path in (sys.argv[1], sys.argv[6], sys.argv[7])): raise ValueError()
    if any(overlaps(left, right) for left, right in ((sys.argv[1], sys.argv[6]), (sys.argv[1], sys.argv[7]), (sys.argv[6], sys.argv[7]))): raise ValueError()
    expected_env = {}
    with open(sys.argv[4], "r", encoding="ascii") as source:
        for line in source:
            line = line.rstrip("\n")
            if not line or "=" not in line: raise ValueError()
            key, value = line.split("=", 1)
            if key in expected_env: raise ValueError()
            expected_env[key] = value
    allowed_keys = {"SERVUS_IMAGE", "SERVUS_DATA_DIR", "SERVUS_PORT", "SERVUS_INGRESS_PORT", "SERVUS_DOCKER_GID", "SERVUS_BIND_ADDRESS", "SERVUS_PUBLIC_URL", "SERVUS_ALLOWED_ORIGINS", "SERVUS_SECURE_COOKIES", "SERVUS_SOURCE_REF", "SERVUS_LIFECYCLE_DIR", "SERVUS_TRUSTED_PROXY_SECRET", "SERVUS_SUPERVISOR_CONTROL_DIR", "SERVUS_SUPERVISOR_SECRET_DIR", "SERVUS_UPDATER_SOCKET_DIR"}
    if set(expected_env) - allowed_keys or expected_env.get("SERVUS_IMAGE") != sys.argv[2] or expected_env.get("SERVUS_DATA_DIR") != data_dir or expected_env.get("SERVUS_LIFECYCLE_DIR") != sys.argv[1] or expected_env.get("SERVUS_SUPERVISOR_CONTROL_DIR") != sys.argv[6] or expected_env.get("SERVUS_SUPERVISOR_SECRET_DIR") != sys.argv[7]: raise ValueError()
    updater_dir = expected_env.get("SERVUS_UPDATER_SOCKET_DIR")
    if updater_dir is not None and updater_dir != "/run/servus-updater/control": raise ValueError()
    ingress = expected_env.get("SERVUS_INGRESS_PORT", "80")
    origins = expected_env["SERVUS_ALLOWED_ORIGINS"]
    cookies = expected_env.get("SERVUS_SECURE_COOKIES", "false")
    secret = expected_env.get("SERVUS_TRUSTED_PROXY_SECRET", "")
    bind_address = expected_env.get("SERVUS_BIND_ADDRESS", "0.0.0.0")
    published_port = expected_env.get("SERVUS_PORT", "4180")
    docker_gid = expected_env["SERVUS_DOCKER_GID"]
    if not ingress or not origins or cookies not in ("true", "false") or (secret and (len(secret) != 64 or any(c not in "0123456789abcdef" for c in secret))): raise ValueError()
    if bind_address not in ("127.0.0.1", "0.0.0.0") or not re.fullmatch(r"[1-9][0-9]{0,4}", published_port) or int(published_port) > 65535 or not re.fullmatch(r"[0-9]+", docker_gid): raise ValueError()
    with open(sys.argv[5], "rb") as stream: image_data = stream.read(65537)
    if len(image_data) > 65536: raise ValueError()
    image_values = json.loads(image_data)
    if not isinstance(image_values, list): raise ValueError()
    image_environment = {}
    for item in image_values:
        if not isinstance(item, str) or "=" not in item: raise ValueError()
        key, value = item.split("=", 1)
        if not key or key in image_environment: raise ValueError()
        image_environment[key] = value
    if set(image_environment) != {"PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "PANEL_DATA_DIR", "PANEL_HOST", "PANEL_PORT"}: raise ValueError()
    if image_environment["PATH"] != "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" or image_environment["NODE_ENV"] != "production" or image_environment["PANEL_DATA_DIR"] != "/var/lib/panel" or image_environment["PANEL_HOST"] != "0.0.0.0" or image_environment["PANEL_PORT"] != "4180": raise ValueError()
    if not re.fullmatch(r"24\.[0-9]+\.[0-9]+", image_environment["NODE_VERSION"]) or not re.fullmatch(r"1\.[0-9]+\.[0-9]+", image_environment["YARN_VERSION"]): raise ValueError()
    document = json.load(sys.stdin)
    if not isinstance(document, dict) or document.get("name") != "servus" or any(key not in {"name", "services", "networks"} and not key.startswith("x-") for key in document): raise ValueError()
    networks = document.get("networks")
    if not isinstance(networks, dict) or set(networks) != {"default"}: raise ValueError()
    network = networks["default"]
    if not isinstance(network, dict) or set(network) - {"name", "ipam"} or network.get("name") != "servus_default" or network.get("ipam", {}) != {}: raise ValueError()
    services = document["services"]
    if set(services) != {"api", "worker", "agent"}: raise ValueError()
    expected = {"api": "dist/server/index.js", "worker": "dist/worker/index.js", "agent": "dist/agent/index.js"}
    for name, command in expected.items():
        service = services[name]
        common = {"restart", "command", "entrypoint", "environment", "image", "init", "networks", "volumes"}
        specific = {"agent": {"group_add", "healthcheck"}, "api": {"depends_on", "healthcheck", "ports"}, "worker": {"depends_on"}}
        if not isinstance(service, dict) or set(service) != common | specific[name]: raise ValueError()
        if service.get("image") != sys.argv[2] or service.get("entrypoint") != ["/bin/sh", "/app/lifecycle-gate.sh"] or service.get("command") != [command]: raise ValueError()
        if service.get("restart") != "unless-stopped" or service.get("init") is not True or service.get("networks") not in ({"default": None}, {"default": {}}): raise ValueError()
        environment = {"PANEL_DATA_DIR": data_dir, "PANEL_INGRESS_PORT": ingress, "PANEL_SUPERVISOR_SOCKET": "/run/servus-supervisor/socket", "PANEL_SUPERVISOR_SECRET_FILE": "/run/servus-control/token"}
        if name == "api":
            environment.update({"PANEL_HOST": "0.0.0.0", "PANEL_PORT": "4180", "PANEL_ALLOWED_ORIGINS": origins, "PANEL_SECURE_COOKIES": cookies, "PANEL_TRUSTED_PROXY_SECRET": secret})
            if updater_dir is not None: environment.update({"PANEL_UPDATER_SOCKET": "/run/servus-updater/updater.sock", "PANEL_UPDATER_APPLY_ENABLED": "true"})
        if service.get("environment") != environment: raise ValueError()
        effective = dict(image_environment)
        effective.update(environment)
        expected_effective = {key: image_environment[key] for key in ("PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "PANEL_HOST", "PANEL_PORT")}
        expected_effective.update(environment)
        if effective != expected_effective: raise ValueError()
        if name == "agent" and service.get("group_add") != [docker_gid]: raise ValueError()
        if name in ("api", "worker"):
            depends = service.get("depends_on")
            names = {"agent"} if name == "api" else {"agent", "api"}
            if not isinstance(depends, dict) or set(depends) != names: raise ValueError()
            for dependency in depends.values():
                if not isinstance(dependency, dict) or set(dependency) - {"condition", "required", "restart"} or dependency.get("condition") != "service_healthy" or dependency.get("required", True) is not True or dependency.get("restart", False) is not False: raise ValueError()
        if name == "api":
            ports = service.get("ports")
            if not isinstance(ports, list) or len(ports) != 1: raise ValueError()
            port = ports[0]
            if not isinstance(port, dict) or set(port) != {"mode", "host_ip", "target", "published", "protocol"} or port.get("mode") != "ingress" or port.get("host_ip") != bind_address or port.get("target") != 4180 or str(port.get("published")) != published_port or port.get("protocol") != "tcp": raise ValueError()
        if name in ("api", "agent"):
            health = service.get("healthcheck")
            test = ["CMD", "node", "-e", "fetch(\x27http://127.0.0.1:4180/health\x27).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] if name == "api" else ["CMD", "node", "--input-type=module", "-e", "import {runtimeStatus} from \x27./dist/agent/client.js\x27; runtimeStatus().then(s=>process.exit(s.online?0:1)).catch(()=>process.exit(1))"]
            expected_health = {"test": test, "timeout": "5s" if name == "api" else "10s", "interval": "10s" if name == "api" else "5s", "retries": 12 if name == "api" else 24, "start_period": "20s" if name == "api" else "10s"}
            if health != expected_health: raise ValueError()
        mounts = service.get("volumes")
        if not isinstance(mounts, list): raise ValueError()
        for m in mounts:
            if not isinstance(m, dict) or not {"type", "source", "target"}.issubset(m) or set(m) - {"type", "source", "target", "read_only", "bind"}: raise ValueError()
            if not isinstance(m["type"], str) or not isinstance(m["source"], str) or not isinstance(m["target"], str): raise ValueError()
            if "read_only" in m and not isinstance(m["read_only"], bool): raise ValueError()
            bind = m.get("bind", {})
            if not isinstance(bind, dict) or set(bind) - {"create_host_path"} or ("create_host_path" in bind and not isinstance(bind["create_host_path"], bool)): raise ValueError()
        targets = {m["target"]: m for m in mounts}
        expected_targets = {"/run/servus-lifecycle", "/run/servus-supervisor", "/run/servus-control/token", sys.argv[3]}
        if name == "agent": expected_targets.add("/var/run/docker.sock")
        if name == "api" and updater_dir is not None: expected_targets.add("/run/servus-updater")
        if len(targets) != len(mounts) or set(targets) != expected_targets: raise ValueError()
        mount = targets["/run/servus-lifecycle"]
        if mount.get("type") != "bind" or mount.get("source") != sys.argv[1] or mount.get("target") != "/run/servus-lifecycle" or mount.get("read_only") is not True or mount.get("bind", {}).get("create_host_path", False) is not False: raise ValueError()
        control = targets["/run/servus-supervisor"]
        token = targets["/run/servus-control/token"]
        if control.get("type") != "bind" or control.get("source") != sys.argv[6] or control.get("read_only") is not True or control.get("bind", {}).get("create_host_path", False) is not False: raise ValueError()
        if token.get("type") != "bind" or token.get("source") != sys.argv[7] + "/" + name or token.get("read_only") is not True or token.get("bind", {}).get("create_host_path", False) is not False: raise ValueError()
        if name == "api" and updater_dir is not None:
            updater = targets["/run/servus-updater"]
            if updater.get("type") != "bind" or updater.get("source") != updater_dir or updater.get("read_only") is not True or updater.get("bind", {}).get("create_host_path", False) is not False: raise ValueError()
        data = targets[sys.argv[3]]
        if data.get("type") != "bind" or data.get("source") != sys.argv[3] or data.get("read_only", False) is not False: raise ValueError()
        if name == "agent":
            socket = targets["/var/run/docker.sock"]
            if socket.get("type") != "bind" or socket.get("source") != "/var/run/docker.sock" or socket.get("read_only", False) is not False: raise ValueError()
    canonical = {key: value for key, value in document.items() if not key.startswith("x-")}
    fd = os.open(sys.argv[8], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        os.fchmod(target.fileno(), 0o600)
        json.dump(canonical, target, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        target.write("\n"); target.flush(); os.fsync(target.fileno())
except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, json.JSONDecodeError):
    print("Servus: Release Compose lifecycle wiring is invalid.", file=sys.stderr)
    sys.exit(1)
