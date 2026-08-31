"""Vigía — servidor de videovigilancia casera."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import logging_setup
from .auth import require_auth
from .config import DATA_DIR
from .routers import cameras, events, recordings, settings, stream, system
from .services.manager import manager

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging_setup.setup()
    import logging

    log = logging.getLogger("vigia")
    log.info("Arrancando Vigía (datos en %s)", DATA_DIR)
    manager.start_all()
    log.info("%d cámara(s) activa(s)", len(manager.workers))
    try:
        yield
    finally:
        manager.stop_all()
        log.info("Vigía detenido")


app = FastAPI(
    title="Vigía",
    description="Monitoriza y graba tus cámaras en casa: RTSP, ONVIF y USB.",
    version="0.1.0",
    lifespan=lifespan,
)

# Permite abrir la interfaz desde el móvil u otro equipo de la LAN.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (cameras.router, stream.router, recordings.router,
               events.router, settings.router, system.router):
    app.include_router(router, prefix="/api", dependencies=[Depends(require_auth)])


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html")


# El resto de ficheros estáticos (css, js, iconos)
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
