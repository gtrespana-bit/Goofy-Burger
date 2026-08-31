#!/usr/bin/env bash
# Arranca Vigía en macOS / Linux.
# Uso:  ./start.sh            (sólo en este equipo)
#       ./start.sh --lan      (accesible desde el móvil y otros equipos)
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Creando entorno virtual…"
  python3 -m venv .venv
fi

. .venv/bin/activate

python - <<'PY' || true
import importlib
missing = [m for m in ("fastapi", "uvicorn", "cv2", "requests", "onvif", "imageio_ffmpeg", "dvrip", "pywebpush")
           if not importlib.util.find_spec(m)]
print("FALTAN:" + ",".join(missing) if missing else "deps-ok")
PY

if ! python -c "import fastapi, uvicorn, cv2, requests, onvif, imageio_ffmpeg, dvrip, pywebpush" 2>/dev/null; then
  echo "Instalando dependencias (incluye ONVIF y ffmpeg)…"
  pip install --upgrade pip
  pip install -r requirements.txt
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg no está en el PATH: intentando instalar la versión de pip…"
  pip install imageio-ffmpeg || echo "AVISO: instala ffmpeg manualmente para grabar (brew install ffmpeg / apt install ffmpeg)"
fi

HOST="127.0.0.1"
[ "$1" = "--lan" ] && HOST="0.0.0.0"

echo
echo "  Vigía escuchando en http://${HOST}:8000"
echo "  (Ctrl+C para detener)"
echo
exec python vigia.py --host "$HOST" --port 8000
