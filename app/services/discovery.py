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

DEFAULT_PORTS = [554, 8554, 80, 8080, 8000, 8899, 10554]


# --------------------------------------------------------------------------
# Red local
# --------------------------------------------------------------------------
def local_ip() -> str:
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
    paths = paths or COMMON_RTSP_PATHS
    base_host = host.split("@")[-1]
    if username:
        auth = f"{username}:{password}@"
    else:
        auth = ""
    urls = [f"rtsp://{auth}{base_host}:{p}{path}" for p in ports for path in paths]
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
