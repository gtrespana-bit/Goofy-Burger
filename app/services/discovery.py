"""Autodescubrimiento de cámaras en la red local.

Tres estrategias complementarias, de más "limpia" a más "bestia":

1. **WS-Discovery (ONVIF)** — multicast a 239.255.255.250:3702. Las cámaras
   ONVIF responden con su URL de servicio y sus scopes (modelo, nombre...).
2. **Escaneo de puertos** de la subred local (554/8554 RTSP, 80/8080 http).
3. **Sondeo RTSP** con DESCRIBE sobre rutas habituales de cada fabricante.

Nada de esto requiere dependencias externas; ONVIF "de verdad" (perfiles,
PTZ) vive en ``onvif_client.py``.
"""

from __future__ import annotations

import re
import socket
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

from . import dvrip

MULTICAST_GROUP = "239.255.255.250"
MULTICAST_PORT = 3702

WS_PROBE = """<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"
          xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
          xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <Header>
    <wsa:MessageID>urn:uuid:{uuid}</wsa:MessageID>
    <wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
  </Header>
  <Body>
    <Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery">
      <dn:Types>dn:NetworkVideoTransmitter</dn:Types>
    </Probe>
  </Body>
</Envelope>"""

# Rutas RTSP más habituales por fabricante / firmware
COMMON_RTSP_PATHS = [
    "/h264Preview_01_sub", "/h264Preview_01_main",            # Reolink
    "/Streaming/Channels/102", "/Streaming/Channels/101",      # Hikvision / Dahua / LTS
    "/cam/realmonitor?channel=1&subtype=1",                    # Dahua / Amcrest
    "/cam/realmonitor?channel=1&subtype=0",
    "/live/ch0", "/live/ch1", "/live/ch00_0", "/live/ch00_1",  # HiSilicon / genéricas
    "/onvif1", "/onvif2", "/onvif-profile-1", "/profile1", "/profile2",
    "/11", "/12", "/1", "/2", "/0", "/av0_0", "/av0_1",
    "/stream1", "/stream2", "/ch0_0.h264", "/ch0_1.h264",
    "/media/video1", "/media/video2", "/video1", "/video2",
    "/mpeg4", "/h264", "/live.sdp", "/rtsp_tunnel",
]

# Rutas RTSP de cámaras XMEye / iCSee (chip XiongMai, HI3516…).
# Aquí las credenciales van EMBEBIDAS EN LA RUTA, no en el usuario de la URL.
# {user}, {password} y {channel} se sustituyen en ``probe_rtsp``.
# En las cámaras multi-lente (p. ej. "3 en 1"), cada lente es un canal distinto.
# Nota: algunos firmwares XiongMai usan ``passwd=`` en vez de ``password=`` y
# las variantes ``_passwd=``, así que las probamos todas.
XMEYE_RTSP_PATHS = [
    # user/password dentro de la ruta con '&'
    "/user={user}&password={password}&channel={channel}&stream=0.sdp?real_stream",
    "/user={user}&password={password}&channel={channel}&stream=1.sdp?real_stream",
    "/user={user}&passwd={password}&channel={channel}&stream=0.sdp?real_stream",
    "/user={user}&passwd={password}&channel={channel}&stream=1.sdp?real_stream",
    "/user={user}&password={password}&channel={channel}&stream=0.sdp",
    "/user={user}&password={password}&channel={channel}&stream=1.sdp",
    "/user={user}&password={password}&channel={channel}&stream=0.sdp?",
    "/user={user}&password={password}&channel={channel}&stream=1.sdp?",
    "/user={user}&password={password}&channel={channel}&stream=0.sdp?real_stream&video=0",
    "/user={user}&password={password}&channel={channel}&stream=0.sdp?real_stream&video=1",
    "/user={user}&password={password}&channel={channel}&stream=0",
    "/user={user}&password={password}&channel={channel}&stream=1",
    # variantes con guion bajo (muy comunes en XMEye)
    "/user={user}_password={password}_channel={channel}_stream=0.sdp?real_stream",
    "/user={user}_password={password}_channel={channel}_stream=1.sdp?real_stream",
    "/user={user}_passwd={password}_channel={channel}_stream=0.sdp?real_stream",
    "/user={user}_passwd={password}_channel={channel}_stream=1.sdp?real_stream",
    "/user={user}_password={password}_channel={channel}_stream=0.sdp",
    "/user={user}_password={password}_channel={channel}_stream=1.sdp",
    "/user={user}_password={password}_channel={channel}_stream=0.sdp?",
    "/user={user}_password={password}_channel={channel}_stream=1.sdp?",
    "/user={user}_password={password}_channel={channel}_stream=0.sdp?real_stream",
    "/user={user}_password={password}&channel={channel}&stream=0.sdp?real_stream",
    # variantes sin user/pass en la ruta (cred. en el usuario de la URL o sin auth)
    "/channel={channel}_stream=0&onvif=0.sdp?real_stream",
    "/channel={channel}_stream=1&onvif=0.sdp?real_stream",
    "/channel={channel}_stream=0.sdp?real_stream",
    "/channel={channel}_stream=1.sdp?real_stream",
    "/channel={channel}_stream=0.sdp",
    "/channel={channel}_stream=1.sdp",
]

# Canales a sondear en cámaras XMEye/iCSee. La mayoría tienen 1, pero las
# multi-lente ("2 en 1", "3 en 1"…) llegan a 3 o 4. Sondeamos 1-4 por si acaso.
# El canal 0, en algunos firmwares, expone la vista combinada (mosaico) de todos
# los lentes; en otros simplemente no responde. Se sondea aparte como candidato.
XMEYE_CHANNELS = [1, 2, 3, 4]
XMEYE_MOSAIC_CHANNEL = "0"

DEFAULT_PORTS = [554, 8554, 80, 8080, 8000, 8899, 10554]


# --------------------------------------------------------------------------
# Red local
# --------------------------------------------------------------------------
def _resolve_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


# La IP local se consulta en cada /system/info (la UI lo sondea cada 5 s).
# Resolverla abre un socket y, si falla, puede bloquear en DNS. La cacheamos.
_local_ip: Dict[str, object] = {"ts": 0.0, "ip": ""}
_LOCAL_IP_TTL = 60.0


def local_ip() -> str:
    now = time.time()
    if _local_ip["ip"] and (now - float(_local_ip["ts"])) < _LOCAL_IP_TTL:
        return str(_local_ip["ip"])
    ip = _resolve_local_ip()
    _local_ip["ip"] = ip
    _local_ip["ts"] = now
    return ip


def local_subnets(prefixlen: int = 24) -> List[str]:
    """Devuelve subredes en notación CIDR para la IP principal."""
    ip = local_ip()
    if ip.startswith("127."):
        return []
    octets = ip.split(".")
    if prefixlen == 24:
        return [f"{octets[0]}.{octets[1]}.{octets[2]}.0/24"]
    return [f"{ip}/{prefixlen}"]


def _cidr_hosts(cidr: str) -> List[str]:
    net, bits = cidr.split("/")
    bits = int(bits)
    if bits < 16 or bits > 32:
        return []
    base = net.split(".")
    if bits == 24:
        return [f"{base[0]}.{base[1]}.{base[2]}.{i}" for i in range(1, 255)]
    if bits == 16:
        hosts = []
        for b in range(0, 256):
            for c in range(0, 256):
                hosts.append(f"{base[0]}.{base[1]}.{b}.{c}")
        return hosts
    start = int.from_bytes(socket.inet_aton(net), "big")
    count = 1 << (32 - bits)
    return [
        socket.inet_ntoa((start + i).to_bytes(4, "big")) for i in range(1, min(count - 1, 4096))
    ]


# --------------------------------------------------------------------------
# 1. WS-Discovery
# --------------------------------------------------------------------------
def discover_onvif(timeout: float = 4.0, attempts: int = 2) -> List[Dict]:
    """Envía un Probe WS-Discovery y recoge las respuestas."""
    message = WS_PROBE.format(uuid=str(uuid.uuid4())).encode("utf-8")
    found: Dict[str, Dict] = {}

    for _ in range(max(1, attempts)):
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            except Exception:
                pass
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 4)
            sock.settimeout(timeout)
            sock.sendto(message, (MULTICAST_GROUP, MULTICAST_PORT))
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    data, addr = sock.recvfrom(65535)
                except socket.timeout:
                    break
                except Exception:
                    break
                item = _parse_probe_response(data.decode("utf-8", "ignore"), addr[0])
                if item:
                    key = item.get("ip") or item.get("xaddrs", "")
                    if key and key not in found:
                        found[key] = item
        except Exception:
            continue
        finally:
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
    return list(found.values())


def _parse_probe_response(xml_text: str, src_ip: str) -> Optional[Dict]:
    xaddrs = re.search(r"<[^>]*XAddrs[^>]*>(.*?)</[^>]*XAddrs>", xml_text, re.S)
    if not xaddrs:
        return None
    urls = re.findall(r"http://[^\s<]+", xaddrs.group(1))
    scopes = re.search(r"<[^>]*Scopes[^>]*>(.*?)</[^>]*Scopes>", xml_text, re.S)
    scope_list = re.findall(r"onvif://[^\s<]+", scopes.group(1)) if scopes else []
    name = ""
    hardware = ""
    for scope in scope_list:
        if "/name/" in scope:
            name = scope.split("/name/", 1)[1]
        elif "/hardware/" in scope:
            hardware = scope.split("/hardware/", 1)[1]
        elif not name and "/type/" in scope:
            pass
    return {
        "ip": src_ip,
        "xaddrs": urls,
        "name": name.replace("%20", " ").strip() or f"Dispositivo ONVIF {src_ip}",
        "hardware": hardware.replace("%20", " ").strip(),
        "scopes": scope_list,
        "protocol": "onvif",
    }


# --------------------------------------------------------------------------
# 2. Escaneo de puertos
# --------------------------------------------------------------------------
def _port_open(host: str, port: int, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def scan_network(cidr: Optional[str] = None, ports: Optional[List[int]] = None,
                 workers: int = 96, timeout: float = 0.6) -> List[Dict]:
    """Busca hosts con puertos típicos de cámara abiertos."""
    subnets = [cidr] if cidr else local_subnets()
    ports = ports or DEFAULT_PORTS
    results: Dict[str, Dict] = {}

    def check(item):
        host, port = item
        if _port_open(host, port, timeout):
            return host, port
        return None

    for subnet in subnets:
        hosts = _cidr_hosts(subnet)
        tasks = [(h, p) for h in hosts for p in ports]
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for res in pool.map(check, tasks):
                if not res:
                    continue
                host, port = res
                entry = results.setdefault(
                    host, {"ip": host, "ports": [], "protocol": "scan", "name": f"Dispositivo {host}"}
                )
                entry["ports"].append(port)
    for entry in results.values():
        entry["ports"].sort()
    return list(results.values())


# --------------------------------------------------------------------------
# 3. Sondeo RTSP (DESCRIBE)
# --------------------------------------------------------------------------
def rtsp_describe(url: str, timeout: float = 2.5) -> Dict:
    """Hace DESCRIBE y devuelve {'ok':bool,'status':int,'sdp':str}.

    200 = acceso directo, 401 = necesita credenciales (la cámara existe).
    """
    try:
        parts = url.replace("rtsp://", "", 1).split("/", 1)
        hostport = parts[0]
        path = "/" + parts[1] if len(parts) > 1 else "/"
        if "@" in hostport:
            hostport = hostport.split("@", 1)[1]
        host, _, port_s = hostport.partition(":")
        port = int(port_s or 554)
        sock = socket.create_connection((host, port), timeout=timeout)
        request = (
            f"DESCRIBE {url} RTSP/1.0\r\n"
            f"CSeq: 1\r\n"
            f"User-Agent: vigia/1.0\r\n"
            f"Accept: application/sdp\r\n\r\n"
        )
        sock.sendall(request.encode())
        sock.settimeout(timeout)
        data = b""
        try:
            while len(data) < 65536 and b"\r\n\r\n" not in data:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
        except socket.timeout:
            pass
        sock.close()
        text = data.decode("utf-8", "ignore")
        match = re.match(r"RTSP/1\.0\s+(\d+)", text)
        status = int(match.group(1)) if match else 0
        return {"ok": status in (200, 401), "status": status, "sdp": text}
    except Exception as exc:
        return {"ok": False, "status": 0, "sdp": "", "error": f"{type(exc).__name__}: {exc}"}


def probe_rtsp(host: str, username: str = "", password: str = "",
               ports: Optional[List[int]] = None,
               paths: Optional[List[str]] = None,
               workers: int = 16, timeout: float = 2.5) -> List[str]:
    """Prueba combinaciones puerto+ruta y devuelve las URLs que responden."""
    ports = ports or [554, 8554]
    base_host = host.split("@")[-1]
    auth = f"{username}:{password}@" if username else ""

    if paths is not None:
        path_list = list(paths)
    else:
        path_list = COMMON_RTSP_PATHS + XMEYE_RTSP_PATHS

    # Para las rutas XMEye/iCSee las credenciales van dentro de la ruta. La
    # cuenta RTSP de estas cámaras suele ser 'admin' (aunque en la app se entre
    # con otra cuenta), así que probamos la dada y unos cuantos valores por
    # defecto muy habituales.
    credential_sets: List[tuple] = []
    if username:
        credential_sets.append((username, password))
    if (username or "").lower() != "admin":
        credential_sets += [("admin", password), ("admin", "")]
    if not credential_sets:
        credential_sets = [("admin", "")]

    urls: List[str] = []
    for port in ports:
        for path in path_list:
            if "{channel}" in path:
                # Rutas XMEye/iCSee multi-lente: un canal (lente) por URL.
                # El canal 0, si responde, suele ser la vista combinada (mosaico).
                embedded = "{user}" in path or "{password}" in path
                for channel in list(XMEYE_CHANNELS) + [XMEYE_MOSAIC_CHANNEL]:
                    if embedded:
                        for u, pw in credential_sets:
                            try:
                                filled = path.format(user=u, password=pw, channel=channel)
                            except (KeyError, ValueError):
                                continue
                            urls.append(f"rtsp://{base_host}:{port}{filled}")
                    else:
                        try:
                            filled = path.format(channel=channel)
                        except (KeyError, ValueError):
                            continue
                        urls.append(f"rtsp://{auth}{base_host}:{port}{filled}")
            else:
                urls.append(f"rtsp://{auth}{base_host}:{port}{path}")

    valid: List[str] = []

    def check(url):
        res = rtsp_describe(url, timeout)
        return url if res.get("ok") else None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for url in pool.map(check, urls):
            if url:
                valid.append(url)
    # Las que devuelven 200 primero
    return valid


# --------------------------------------------------------------------------
# 3b. Agrupar canales multi-lente (iCSee/XMEye)
# --------------------------------------------------------------------------
_CHANNEL_RE = re.compile(r"(?:^|[?&_/]|[A-Za-z])channel=(\d+)", re.I)
_STREAM_RE = re.compile(r"(?:^|[?&_/]|[A-Za-z])stream=(\d+)", re.I)


def _channel_param(url: str) -> Optional[str]:
    m = _CHANNEL_RE.search(url)
    return m.group(1) if m else None


def _stream_param(url: str) -> Optional[str]:
    m = _STREAM_RE.search(url)
    return m.group(1) if m else None


def group_rtsp_channels(urls: List[str]) -> Dict:
    """Agrupa URLs RTSP iCSee/XMEye por canal y separa main/sub-stream.

    Devuelve ``{'groups': [...], 'leftover': [...]}``.
    Un grupo ``mosaic=True`` significa canal 0 (vista combinada de las lentes).
    """
    groups: Dict[str, Dict] = {}
    leftover: List[str] = []
    for url in urls:
        channel = _channel_param(url)
        if channel is None:
            leftover.append(url)
            continue
        # Remove query/fragment so we can compare host/path without creds in logs.
        key_src = url.split("://", 1)[-1].split("/", 1)[0]
        key = f"{channel}@{key_src}" if key_src else channel
        g = groups.setdefault(
            key, {"channel": channel, "main": "", "sub": "", "mosaic": channel == "0"}
        )
        is_sub = (_stream_param(url) == "1")
        if is_sub:
            if not g["sub"]:
                g["sub"] = url
        elif not g["main"]:
            g["main"] = url
    ordered = sorted(groups.values(), key=lambda g: int(g["channel"] or 0))
    for g in ordered:
        g["label"] = "Mosaico" if g["mosaic"] else f"Lente {g['channel']}"
    return {"groups": ordered, "leftover": leftover}


def _rtsp_distinguishes_lenses(channels: Dict, host: str, timeout: float) -> Optional[bool]:
    """¿Los canales RTSP devuelven flujos distintos o todos la misma lente?

    Muchas iCSee/XMEye (XiongMai) ignoran ``channel=1/2/3`` en RTSP y devuelven
    SIEMPRE la lente principal: así, al añadir "Lente 1, 2, 3" por RTSP salen
    tres copias de la misma cámara. Comparamos el SDP de cada canal: si son
    idénticos (salvo el identificador de sesión ``o=``), la cámara no distingue
    lentes por RTSP y hay que usar ONVIF o DVRIP.

    Devuelve ``True`` (distinguen), ``False`` (no distinguen) o ``None`` (no se
    pudo comprobar: sin canales, sin credenciales o sin respuesta SDP).
    """
    groups = [g for g in (channels or {}).get("groups", []) if not g.get("mosaic") and g.get("main")]
    if len(groups) < 2:
        return None
    sdps = []
    for g in groups:
        try:
            res = rtsp_describe(g["main"], timeout=timeout)
        except Exception:
            return None
        sdp = (res.get("sdp") or "") if res.get("ok") else ""
        if not sdp:
            return None
        # El campo o= lleva un identificador de sesión único por conexión;
        # no cuenta a la hora de comparar el contenido de vídeo.
        norm = "\n".join(
            line for line in sdp.splitlines() if not line.startswith("o=")
        )
        sdps.append(norm)
    if not sdps:
        return None
    return len(set(sdps)) > 1


# --------------------------------------------------------------------------
# 4. Diagnóstico de una IP (iCSee / XMEye)
# --------------------------------------------------------------------------
# Puertos típicos de una cámara iCSee/XMEye (chip XiongMai).
ICSEE_PORTS = [554, 8554, 8899, 34567, 8000, 80, 8080, 37777, 10554, 9999]

ICSEE_PORT_LABELS = {
    554: "RTSP (vídeo)",
    8554: "RTSP alternativo",
    8899: "ONVIF (control/PTZ)",
    34567: "DVRIP/NetIP (protocolo propietario iCSee)",
    8000: "web / stream",
    80: "web (interfaz)",
    8080: "web alternativo",
    37777: "Dahua/DVR",
    10554: "RTSP alternativo",
    9999: "stream",
}


def port_report(host: str, ports=None, timeout: float = 1.0,
                workers: int = 24) -> List[Dict]:
    """Comprueba qué puertos típicos de cámara iCSee están abiertos en un host."""
    ports = ports or ICSEE_PORTS

    def check(p):
        try:
            open_ = _port_open(host, p, timeout)
        except Exception:
            open_ = False
        return {"port": p, "open": open_, "label": ICSEE_PORT_LABELS.get(p, "")}

    if not ports:
        return []
    if len(ports) == 1 or not hasattr(ThreadPoolExecutor, "__name__"):
        return [check(p) for p in ports]
    with ThreadPoolExecutor(max_workers=min(workers, len(ports))) as pool:
        return list(pool.map(check, ports))


def diagnose_camera(host: str, username: str = "", password: str = "",
                    timeout: float = 1.2, rtsp_timeout: float = 1.8) -> Dict:
    """Reporte completo de una IP concreta, pensado para cámaras iCSee/XMEye.

    Comprueba puertos, sondea RTSP con todas las variantes de ruta y conjuntos
    de credenciales habituales, y devuelve además pistas de configuración según
    lo que encuentre (RTSP apagado, credenciales RTSP distintas de la web…).
    """
    host = (host or "").strip()
    report: Dict = {
        "host": host,
        "ports": port_report(host, timeout=timeout),
        "rtsp": [],
        "rtsp_admin_empty": [],
        "hints": [],
    }

    # Sólo sondeamos RTSP si algún puerto RTSP está abierto (si no, el
    # DESCRIBE no va a responder y perderíamos tiempo a lo tonto).
    opened = {p["port"] for p in report["ports"] if p["open"]}
    rtsp_ports = [p for p in (554, 8554, 10554) if p in opened]
    if 8000 in opened:
        rtsp_ports.append(8000)

    if rtsp_ports:
        report["rtsp"] = probe_rtsp(
            host, username, password, ports=rtsp_ports, timeout=rtsp_timeout,
        )
        # Con credenciales admin/vacía (la típica de RTSP en XiongMai) para
        # distinguir entre "RTSP apagado" y "credenciales web no sirven para RTSP".
        if (username or "").lower() != "admin" or password:
            report["rtsp_admin_empty"] = probe_rtsp(
                host, "admin", "", ports=rtsp_ports, timeout=rtsp_timeout,
            )

    report["channels"] = group_rtsp_channels(report.get("rtsp", []))
    report["channels"]["rtsp_distinguishes_lenses"] = _rtsp_distinguishes_lenses(
        report["channels"], host, rtsp_timeout
    )

    port_open = {p: p in opened for p in [80, 8080, 8899, 34567, 554]}

    # DVRIP/NetIP: la vía más fiable para las iCSee multi-lente que no exponen
    # todas las lentes por RTSP. Enumeramos lentes y estado desde el protocolo
    # propietario que usa la app.
    if port_open.get(34567):
        try:
            dv = dvrip.probe(host, username, password, timeout=max(2.0, timeout * 2))
            if dv.get("login_ok"):
                report["dvrip"] = dv
                report["hints"].append(
                    f"DVRIP/NetIP autenticado: {dv.get('channels', 0)} lente(s) "
                    "detectada(s) por el protocolo de la app iCSee. Usa el botón "
                    "'Añadir los N' para darlas de alta como cámaras independientes."
                )
            elif dv.get("hints"):
                # Pasamos las pistas concretas de dvrip.probe (bloqueado por
                # exceso de intentos, credenciales incorrectas, sesión abierta…)
                # en lugar de un mensaje genérico.
                for h in dv.get("hints"):
                    report["hints"].append(h)
                report["hints"].append(
                    "El puerto DVRIP 34567 está abierto. Prueba la cuenta de la "
                    "app iCSee o admin con su contraseña."
                )
        except Exception as exc:
            report["hints"].append(f"Error sondeando DVRIP/NetIP: {type(exc).__name__}: {exc}")

    if report["rtsp"]:
        report["hints"].append(
            "RTSP disponible: pega la URL que prefieras en 'URL RTSP'. "
            "Si sólo funcionan las de 'admin' sin contraseña, usa esa cuenta "
            "para RTSP (independiente de la cuenta con la que entras en la app iCSee)."
        )
        if report.get("channels", {}).get("rtsp_distinguishes_lenses") is False:
            report["hints"].append(
                "AVISO: los canales RTSP de esta cámara devuelven TODOS la misma "
                "lente (el firmware no distingue lentes por el parámetro channel). "
                "Para ver las lentes por separado NO uses RTSP: añade por "
                "DVRIP/NetIP (puerto 34567) o por ONVIF (perfiles)."
            )
    else:
        if report["rtsp_admin_empty"]:
            report["hints"].append(
                "RTSP responde con admin/contraseña vacía, pero no con tus "
                "credenciales. La cuenta RTSP de las iCSee/XMEye suele "
                "ser 'admin' sin contraseña, DISTINTA de la de la app. "
                "Pega una URL con 'user=admin&password=' directamente."
            )
        elif not port_open.get(554):
            report["hints"].append(
                "El puerto RTSP (554) está cerrado: la cámara NO expone RTSP ahora mismo. "
                "Entra por la web (http://IP/) o por la app iCSee → ajustes del "
                "dispositivo y comprueba que RTSP está ACTIVADO (puerto 554). "
                "Reinicia la cámara y vuelve a diagnosticar."
            )
        else:
            report["hints"].append(
                "El puerto 554 está abierto pero ninguna variante RTSP respondió. "
                "Prueba a reiniciar la cámara y a comprobar en la app iCSee que "
                "tiene 'acceso por RTSP' habilitado y la contraseña RTSP puesta."
            )

    if port_open.get(8899):
        report["hints"].append(
            "Puerto 8899 abierto: la cámara habla ONVIF (control/mover PTZ). "
            "En Vigía se configura con 'user=admin' y la contraseña de admin de la cámara."
        )
    if port_open.get(34567):
        report["hints"].append(
            "Puerto 34567 abierto: protocolo propietario DVRIP/NetIP de iCSee "
            "(así conecta la app). En modelos 3-en-1 algunos firmware sólo "
            "exponen un lente por RTSP y el resto sólo por DVRIP/NetIP; en ese "
            "caso la app iCSee o un bridge como go2rtc pueden exponerlos."
        )

    lens_channels = [
        g for g in report.get("channels", {}).get("groups", []) if not g.get("mosaic")
    ]
    if len(lens_channels) and len(lens_channels) < 3 and port_open.get(34567):
        report["hints"].append(
            f"Se detectaron {len(lens_channels)} canal(es) RTSP de una cámara "
            "multi-lente. Si faltan lentes, es probable que este firmware no "
            "exponga todas por RTSP; prueba a revisar en la app iCSee/ajustes "
            "que cada lente tenga RTSP habilitado, o usa el canal mosaico "
            "(channel=0) para ver las lentes combinadas."
        )
    if not report["rtsp"] and not port_open.get(554) and not port_open.get(80):
        report["hints"].append(
            "No se ve ningún puerto abierto: revisa que Vigía esté en la MISMA "
            "red que la cámara (mismo router, mismo 192.168.0.x) y que no haya "
            "cortafuegos ni 'aislamiento de cliente' en el router."
        )
    return report
