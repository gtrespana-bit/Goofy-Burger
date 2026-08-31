"""Vigía — servidor de videovigilancia casera."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import logging_setup
from .auth import require_auth, require_write
from .config import DATA_DIR
from .routers import analytics, push
from .routers import auth as auth_router_mod
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
    version="1.0.1",
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


@app.middleware("http")
async def no_cache_ui(request: Request, call_next):
    """Evita que la PWA/navegador sirvan una versión vieja de la interfaz."""
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/"):
        # Los datos (cámaras, eventos, ajustes) son dinámicos: no deben
        # quedarse en la caché HTTP ni dar datos antiguos en la UI.
        response.headers.setdefault("Cache-Control", "no-store")
    elif (
        path in ("/", "/index.html", "/app.js", "/styles.css", "/service-worker.js", "/manifest.json")
        or path.endswith((".js", ".css", ".html"))
    ):
        response.headers.setdefault("Cache-Control", "no-cache, no-store, must-revalidate")
    return response


# Login/status públicos para que la interfaz pueda mostrar y resolver la
# autenticación antes de pedir datos protegidos.
app.include_router(auth_router_mod.router, prefix="/api")

for router in (cameras.router, stream.router, recordings.router,
               events.router, settings.router, system.router, analytics.router,
               push.router):
    app.include_router(
        router,
        prefix="/api",
        dependencies=[Depends(require_auth), Depends(require_write)],
    )


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}


@app.get("/__vigia_debug", include_in_schema=False)
def vigia_debug():
    """Página de diagnóstico del backend sin depender de app.js ni de las pestañas.

    Se abre directamente (http://127.0.0.1:8001/__vigia_debug) cuando la
    interfaz no responde, para comprobar si el backend funciona, qué versión
    se sirve o si el navegador está usando una interfaz antigua.
    """
    html = r"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vigía · Diagnóstico</title>
<style>
body{font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:20px}
h1{font-size:20px;margin:0 0 4px}
code{background:#161b22;padding:2px 6px;border-radius:4px;color:#79c0ff}
table{border-collapse:collapse;width:100%;margin-top:12px}
th,td{border:1px solid #30363d;padding:8px 10px;text-align:left;vertical-align:top;font-size:13px}
th{background:#161b22}
.ok{color:#3ddc97}.err{color:#ff6b6b}.warn{color:#ffb454}
pre{background:#161b22;padding:10px;border-radius:6px;overflow:auto;font-size:12px}
a{color:#79c0ff}
</style></head><body>
<h1>🩺 Diagnóstico Vigía</h1>
<p>Este diagnóstico no usa la interfaz normal. Si estás viendo esto, el servidor está sirviendo ficheros.</p>
<p>URL actual: <code id="url"></code> · <button onclick="run()">Recomprobar</button> · abre <b>F12 → Console</b> si algo falla.</p>
<div id="err" style="display:none;background:#3d1414;border:1px solid #ff6b6b;padding:10px;border-radius:6px;margin-top:10px"></div>
<table><thead><tr><th>Comprobación</th><th>Resultado</th><th>Detalle</th></tr></thead><tbody id="rows"></tbody></table>
<div style="margin-top:16px">
<p><b>Qué hacer luego:</b></p>
<ol>
<li>Abre <code>http://127.0.0.1:8001/__vigia_debug</code> y copia aquí la tabla.</li>
<li>Si la fila <b>UI app.js</b> no dice <code>UI_VERSION 2026-08-31.1</code>, estás sirviendo una interfaz vieja: recarga con <code>Ctrl+Shift+R</code>.</li>
<li>Revisa en F12 → Console los errores rojos de la interfaz normal.</li>
</ol>
</div>
<script>
const $=s=>document.querySelector(s);
async function fetchJson(url){
  const t0=performance.now();
  try{
    const r=await fetch(url,{credentials:'same-origin',cache:'no-store'});
    let text='';try{text=await r.text()}catch(e){}
    let j=null;try{j=JSON.parse(text)}catch(e){}
    return {status:r.status,ms:Math.round(performance.now()-t0),data:j,text:text.slice(0,300)};
  }catch(e){return {status:0,ms:Math.round(performance.now()-t0),error:String(e),text:''};}
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function row(name,res,summary){
  const ok=res.status>=200&&res.status<400;
  const cls=ok?'ok':'err';
  const detail=summary||res.text||(res.error?res.error:JSON.stringify(res.data).slice(0,400))||'';
  const tr=document.createElement('tr');
  tr.innerHTML='<td>'+esc(name)+'</td><td class="'+cls+'">HTTP '+esc(res.status)+' · '+res.ms+' ms</td><td><pre>'+esc(detail)+'</pre></td>';
  $('#rows').appendChild(tr);
}
async function checkAppJs(){
  const r=await fetchJson('/app.js?v=20260831');
  const v=r.data===null&&r.text.match(/UI_VERSION\s*=\s*['"]([^'"]+)/);
  row('UI app.js', r, 'UI_VERSION '+(v?v[1]:'no encontrada')+' · primeras líneas: '+r.text.slice(0,120));
}
async function run(){
  $('#rows').innerHTML='';
  $('#url').textContent=location.href;
  const [auth,sw]=await Promise.all([
    fetchJson('/api/auth/status'),
    fetchJson('/service-worker.js?v=20260831')
  ]);
  row('API auth/status',auth, auth.data?('auth_enabled='+auth.data.auth_enabled):'');
  row('Service worker',sw, sw.text.includes('vigia-pro-v5')?'vigia-pro-v5 (nuevo)':'contenido: '+sw.text.slice(0,120));
  const [info,cams,settings]=await Promise.all([
    fetchJson('/api/system/info'),
    fetchJson('/api/cameras'),
    fetchJson('/api/settings')
  ]);
  row('API system/info',info, info.data?('backend '+info.data.version+' · edición '+info.data.edition+' · cámaras config '+info.data.cameras):'');
  const camsInfo=cams.data?((cams.data.cameras||[]).map(c=>c.state+':'+c.name).slice(0,20).join(' || ')):'';
  row('API cameras',cams, camsInfo||'sin cámaras');
  row('API settings',settings, settings.data?('data_dir '+((settings.data._meta||{}).data_dir||'?')+' · sistema '+(settings.data.general||{}).system_name):'');
  const diag=await fetchJson('/api/system/diagnostics');
  row('API system/diagnostics',diag, diag.data?('ffmpeg '+(diag.data.ffmpeg||'?')+' · onvif '+diag.data.onvif_available+' · dvrip '+diag.data.dvrip_available + (diag.data.data_dir_writable?' · datos escribibles':' · DATOS NO ESCRIBIBLES')):'');
  checkAppJs();
}
run();</script></body></html>"""
    return HTMLResponse(html)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html")


# El resto de ficheros estáticos (css, js, iconos)
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
