# 🎥 Vigía

Sistema de videovigilancia casero, **propio y auto-alojado**: añade tus cámaras,
velas en directo, grábalas, recibe avisos cuando pasa algo y revisa después lo
ocurrido. Sin nubes, sin cuotas, sin depender de la app del fabricante.

```text
Cámara RTSP ─┐
Webcam USB  ─┼─► Vigía ─► grabación por segmentos / clips por movimiento
Fichero     ─┘              │
                            ├─► detección de movimiento + IA (YOLO opcional)
                            ├─► directo MJPEG en el navegador
                            ├─► eventos con instantáneas
                            └─► avisos: Telegram · ntfy · webhook · email
```

## Arrancar en 2 minutos

**Windows** · doble clic en `start.bat` (o `start.bat --lan` para abrirlo desde el móvil).

**macOS / Linux**

```bash
./start.sh            # sólo en este equipo
./start.sh --lan      # accesible desde otros equipos de la casa
```

Abre <http://localhost:8000> y pulsa **+ Añadir cámara**.

> ¿Quieres verlo funcionando antes de conectar nada? Crea una cámara de
> **tipo demo**: genera vídeo sintético con movimiento y verás directo,
> detección, eventos y clips al instante.

### A mano

```bash
python -m venv .venv && . .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python vigia.py --lan --port 8000
```

## Requisitos

| Qué | Obligatorio | Para qué |
|---|---|---|
| Python 3.9+ | ✅ | todo |
| **ffmpeg** | recomendado | grabación sin recodificar y miniaturas. Si no está, Vigía intenta usar el binario de `pip install imageio-ffmpeg` |
| `onvif-zeep` | opcional | autodescubrimiento ONVIF, control PTZ (mover/zoom), presets, snapshots |
| `ultralytics` | opcional | detectar **personas, vehículos y mascotas** con YOLO en vez de "movimiento" a secas |

```bash
pip install onvif-zeep      # PTZ y descubrimiento
pip install ultralytics     # detección con IA
```

## Qué sabe hacer

**Cámaras**
- RTSP (Reolink, Hikvision, Dahua, Amcrest, Tapo vía rtsp, iCSee/XMEye…), webcams USB y ficheros de vídeo.
- Flujo principal para grabar + flujo secundario para detectar/ver en directo (así una cámara 4K no te come la CPU).
- Autodescubrimiento: ONVIF (WS-Discovery), escaneo de la subred y sondeo de rutas RTSP habituales por fabricante.
- Prueba de conexión con foto real antes de guardar.

**Vídeo**
- Directo MJPEG en el navegador (sin plugins ni WebRTC).
- Grabación continua por segmentos con `-c copy` (copia el stream: ~0 % de CPU).
- Clips por movimiento **con pre-grabación** (guarda los 5 s anteriores al evento).
- Instantáneas con las cajas de detección dibujadas.
- Reproductor con miniaturas, descarga y borrado.

**Detección**
- Sustractor de fondo con sensibilidad y tamaño mínimo ajustables.
- **Zonas** de inclusión/exclusión dibujadas sobre la imagen (olvida la acera o la copa del árbol).
- Filtro anti-cambios de luz (IR noche/día, faros).
- Modo IA: sólo avisa si hay persona, coche, perro… (YOLO).

**Alertas y privacidad**
- Telegram, ntfy, webhook HTTP y correo, con imagen adjunta y tiempo mínimo entre avisos.
- Modo **fuera de casa** para activar sólo ciertas cámaras.
- Usuario/contraseña opcional (HTTP Basic).
- Retención por días y por espacio máximo en disco, con limpieza automática.

## Cómo encuentra tus cámaras

1. **ONVIF** (estándar): Vigía manda un Probe WS-Discovery a `239.255.255.250:3702` y las cámarascontestan con su nombre, modelo y URL de servicio.
2. **Escaneo de red**: recorre tu subred buscando puertos típicos (554, 8554, 80, 8080…).
3. **Sondeo RTSP**: prueba rutas conocidas (`/h264Preview_01_main`, `/Streaming/Channels/101`, `/cam/realmonitor?channel=1&subtype=0`…) con `DESCRIBE`. Si la cámara responde 200 o 401, existe.

URLs típicas:

| Marca | Flujo principal | Flujo secundario |
|---|---|---|
| Reolink | `rtsp://IP:554/h264Preview_01_main` | `…/h264Preview_01_sub` |
| Hikvision / LTS | `rtsp://IP:554/Streaming/Channels/101` | `…/102` |
| Dahua / Amcrest | `rtsp://IP:554/cam/realmonitor?channel=1&subtype=0` | `…subtype=1` |
| iCSee / XMEye | `rtsp://IP:554/user=admin&password=&channel=1&stream=0.sdp?real_stream` | `…stream=1.sdp…` |

> Las cámaras **iCSee/XMEye** (chip XiongMai) ponen las credenciales **dentro de
> la ruta** (`user=…&password=…`), no en `rtsp://usuario:contraseña@…`. La cuenta
> RTSP suele ser `admin` (a veces con contraseña vacía), distinta de la cuenta
> con la que entras en la app iCSee. Vigía las detecta y sondea automáticamente.
>
> Las cámaras **multi-lente** (p. ej. "2 en 1" o "3 en 1") exponen cada lente
> como un **canal**: `channel=1`, `channel=2`, `channel=3`… Vigía sondea los
> canales 1–4 y ofrece **"➕ Añadir los N"** para darlas de alta todas de golpe,
> cada lente como **cámara independiente** (con su propio directo, detección y
> grabación). Si el firmware expone el canal 0, ese es el **mosaico** (todas las
> lentes en una sola imagen).
>
> **Mover/zoom (PTZ)**: si un lente es motorizado, se controla por **ONVIF en el
> puerto 8899** (cuenta `admin`, no la de la app). Vigía lo configura solo al
> añadir una cámara iCSee. Requiere `pip install onvif-zeep`. Algunas iCSee
> multi-lente no traen ONVIF y sólo hablan su protocolo propietario (NetIP/DVRIP
> por el puerto 34567); en ese caso el PTZ no está disponible vía ONVIF.
>
> **Detección de movimiento**: la hace Vigía analizando el vídeo (sustractor de
> fondo, con sensibilidad y zonas), así que no necesitas activar nada en la app
> iCSee: sirve para cualquiera de los lentes por igual.

Si la cámara pide usuario, ponlo en el formulario y Vigía lo inyecta en la URL.

### 🔧 Mi cámara iCSee/XMEye no aparece / no me deja entrar

Lo más habitual con estas cámaras (chip XiongMai) no es la URL, sino **quién
tiene permiso para ver el stream**. La cuenta con la que entras en la **app
iCSee** (p. ej. `Ruben`) y en la **web** (`http://IP/`) **no es la misma** que
usa el **RTSP**. El RTSP normalmente usa la cuenta **`admin` sin contraseña**
(o la contraseña que le pongas a `admin`), no la del usuario normal.

Pasos:

1. En el asistente «Añadir cámara» escribe la IP de tu cámara en el campo
   **«IP de la cámara»** y pulsa **🔧 Diagnosticar iCSee**. Vigía comprobará
   los puertos (RTSP 554, ONVIF 8899, web 80…) y sondeará todas las variantes
   RTSP con varias cuentas, y te dirá exactamente por qué no hay imagen.
2. Si el diagnóstico dice que **RTSP (554) está cerrado**: entra por la web
   (`http://IP/`) o en la app iCSee → ajustes del dispositivo y **activa RTSP**
   (puerto 554); reinicia la cámara y vuelve a diagnosticar.
3. Si el RTSP responde con **`admin` sin contraseña** pero no con tu usuario:
   pega una URL RTSP que lleve `user=admin&password=` en la propia ruta:
   `rtsp://IP:554/user=admin&password=&channel=1&stream=0.sdp?real_stream`
   (la `password` se deja vacía; si le pusiste contraseña a `admin`, ponla).
4. Pega la URL en **«URL RTSP»** y pulsa **Probar conexión** para ver una foto
   real antes de guardar.

Una URL iCSee/XMEye válida tiene este aspecto (credenciales **dentro de la
ruta**, y `channel=N` por cada lente si es multi-lente):

```text
rtsp://192.168.0.108:554/user=admin&password=&channel=1&stream=0.sdp?real_stream
```

> Vigía, al conectar, detecta automáticamente estas URLs con credenciales en la
> ruta y respeta la cuenta `admin` (no la pisa con el usuario de la app).

## Dónde se guarda todo

```
data/
├── config.json          # cámaras y ajustes (cópialo para hacer backup)
├── recordings/<cámara>/ # segmentos continuos  20260830T142500.mp4
├── clips/<cámara>/      # clips por movimiento
├── snapshots/<cámara>/  # instantáneas de los eventos
├── thumbs/              # miniaturas cacheadas
├── events.json          # historial de eventos
└── logs/vigia.log
```

Todo se puede mover: **Ajustes → Almacenamiento → Carpeta de grabaciones**.

## API

La interfaz habla con una API REST documentada en <http://localhost:8000/docs>. Lo más útil:

```bash
curl localhost:8000/api/cameras                          # estado de las cámaras
curl localhost:8000/api/events?limit=10                  # últimos eventos
curl -X POST localhost:8000/api/system/discover \
     -H 'Content-Type: application/json' \
     -d '{"mode":"onvif","username":"admin","password":"1234"}'
curl -X POST localhost:8000/api/cameras/ID/record?seconds=60   # grabación manual
```

## Consejos

- **Usa el flujo secundario** para detectar: 640 px son suficientes y tu CPU lo agradece.
- Empieza con sensibilidad 55 y bájala si te saltan avisos por lluvia u hojas.
- Dibuja zonas en las cámaras exteriores: elimina el 90 % de los falsos positivos.
- Un disco de 1 TB con 4 cámaras a 1080p/15 fps ronda los 10-14 días de retención.
- Para acceder desde fuera de casa, usa VPN (Tailscale/WireGuard) antes que abrir puertos.

## Licencia

MIT. Úsalo, cámbialo y hazlo tuyo.
