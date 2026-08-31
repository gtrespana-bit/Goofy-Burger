/* Vigía — interfaz web */
'use strict';

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T'));
  return isNaN(d) ? iso : d.toLocaleString('es-ES', { hour12: false });
}
function timeAgo(iso) {
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return '';
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { toast('Sesión no autenticada', 'err'); throw new Error('401'); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
const state = {
  view: 'dashboard',
  cameraId: null,
  cameras: [],
  events: [],
  recordings: [],
  settings: {},
  info: {},
  filters: { recCamera: '', recDate: '', recKind: '', evCamera: '', evLabel: '', evUnack: false },
  lastEventTs: null,
};

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */
function openModal(title, html, opts = {}) {
  const modal = $('#modal');
  const modalTitle = $('#modal-title');
  const modalBody = $('#modal-body');
  
  if (modalTitle) modalTitle.textContent = title;
  if (modalBody) modalBody.innerHTML = html || '';
  
  if (modal) {
    const modalEl = modal.querySelector('.modal');
    if (modalEl) modalEl.classList.toggle('wide', !!opts.wide);
    modal.hidden = false;
  }
  
  if (opts.onMount && modalBody) opts.onMount(modalBody);
  return modalBody;
}
function closeModal() {
  const modal = $('#modal');
  const modalBody = $('#modal-body');
  if (modal) modal.hidden = true;
  if (modalBody) modalBody.innerHTML = '';
}

function confirmModal(title, text, onYes) {
  openModal(title, `<p>${esc(text)}</p>
    <div class="row" style="justify-content:flex-end;margin-top:18px">
      <button class="btn ghost" data-close>Cancelar</button>
      <button class="btn danger" data-yes>Confirmar</button>
    </div>`);
  $('#modal-body').addEventListener('click', e => {
    if (e.target.dataset.yes) { closeModal(); onYes(); }
    if (e.target.dataset.close || e.target.id === 'modal-close') closeModal();
  });
}

/* ------------------------------------------------------------------ */
/* Arranque y navegación                                               */
/* ------------------------------------------------------------------ */
// Configurar el modal IMMEDIATELY para evitar problemas si boot() falla
(function() {
  const modal = $('#modal');
  const modalClose = $('#modal-close');
  
  // Asegurarse de que el modal esté oculto al inicio
  if (modal) {
    modal.hidden = true;
    
    // Configurar event listeners del modal de inmediato
    if (modalClose) {
      modalClose.onclick = closeModal;
    }
    
    modal.addEventListener('click', e => { 
      if (e.target.id === 'modal') closeModal(); 
    });
  }
  
  document.addEventListener('keydown', e => { 
    if (e.key === 'Escape') closeModal(); 
  });
  
  // Failsafe: ocultar modal después de 500ms por si algo lo hizo visible
  setTimeout(() => {
    const m = $('#modal');
    if (m && !m.hidden && !m.querySelector('.modal-body').innerHTML.trim()) {
      m.hidden = true;
    }
  }, 500);
})();

async function boot() {
  // Los event listeners del modal ya están configurados arriba
  // No necesitamos configurarlos de nuevo aquí
  
  try {
    $('#btn-add').onclick = () => cameraWizard();
    $('#btn-refresh').onclick = () => refresh(true);
    $('#btn-away').onclick = async () => {
      const away = !state.settings.general?.away;
      await api('/system/away', { method: 'POST', body: { value: away } });
      state.settings.general = { ...(state.settings.general || {}), away };
      renderTopbar();
      toast(away ? 'Modo fuera de casa activado' : 'Modo en casa');
    };

    $$('#tabs .tab').forEach(tab => {
      tab.onclick = () => { location.hash = '#/' + tab.dataset.view; };
    });
    window.addEventListener('hashchange', route);

    await refresh(true);
    route();
    setInterval(() => refresh(false), 5000);
    setInterval(checkNewEvents, 6000);
  } catch (err) {
    console.error('Error durante el arranque:', err);
    // Asegurarse de que el modal esté oculto si hubo un error
    closeModal();
  }
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, param] = hash.split('/');
  state.view = view || 'dashboard';
  state.cameraId = view === 'camera' ? param : null;
  $$('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === (view || 'dashboard')));
  render();
}

async function refresh(full = false) {
  try {
    const [info, cams, settings] = await Promise.all([
      api('/system/info'),
      api('/cameras'),
      full ? api('/settings') : Promise.resolve(state.settings),
    ]);
    state.info = info;
    state.cameras = cams.cameras || [];
    if (settings && Object.keys(settings).length) state.settings = settings;
    renderTopbar();
    // Repintar todo sólo si cambió el conjunto de cámaras: reconstruir el DOM
    // reiniciaría los streams MJPEG en cada sondeo.
    const sig = state.cameras.map(c => `${c.id}:${c.enabled ? 1 : 0}:${c.name}:${c.group}`).join('|');
    if (full || sig !== state.camSig) {
      state.camSig = sig;
      render();
    } else {
      renderStatusOnly();
    }
  } catch (err) {
    console.error(err);
    $('#system-sub').textContent = 'sin conexión con el servidor';
  }
}

/* ------------------------------------------------------------------ */
/* Barra superior                                                      */
/* ------------------------------------------------------------------ */
function renderTopbar() {
  const cams = state.cameras;
  const online = cams.filter(c => c.health?.state === 'running').length;
  const rec = cams.filter(c => c.health?.recording).length;
  const away = !!state.settings.general?.away;

  $('#system-name').textContent = state.settings.general?.system_name || 'Vigía';
  $('#system-sub').textContent =
    `${state.info.local_ip || ''} · ${state.info.platform || ''} · ffmpeg ${state.info.ffmpeg ? '✓' : '✗'}`;

  $('#topstats').innerHTML = `
    <span class="stat"><span class="dot ${online ? 'on' : (cams.length ? 'warn' : '')}"></span>
      <b>${online}</b>/${cams.length} cámaras</span>
    <span class="stat"><span class="dot ${rec ? 'rec' : ''}"></span><b>${rec}</b> grabando</span>
    <span class="stat">💾 ${fmtBytes(state.info.storage?.recordings?.bytes || 0)}</span>
    <span class="stat">🎉 ${state.info.events_unacknowledged ?? 0} sin revisar</span>`;

  $('#btn-away').textContent = away ? '🚶 Fuera de casa' : '🏠 En casa';
  $('#btn-away').classList.toggle('primary', away);
}

/* ------------------------------------------------------------------ */
/* Vistas                                                              */
/* ------------------------------------------------------------------ */
function render() {
  const view = state.view;
  if (view === 'dashboard') return renderDashboard();
  if (view === 'camera') return renderCamera();
  if (view === 'events') return renderEvents();
  if (view === 'recordings') return renderRecordings();
  if (view === 'settings') return renderSettings();
  renderDashboard();
}

function renderStatusOnly() {
  // Actualiza sólo los indicadores de las tarjetas ya pintadas
  state.cameras.forEach(cam => {
    const el = document.querySelector(`[data-cam="${cam.id}"]`);
    if (!el) return;
    const st = cam.health?.state || 'stopped';
    const badge = el.querySelector('.badge.state');
    if (badge) {
      badge.className = 'badge state ' + st;
      badge.textContent = stateLabel(st);
    }
    const recBadge = el.querySelector('.badge.rec');
    if (recBadge) recBadge.style.display = cam.health?.recording ? 'flex' : 'none';
    const meta = el.querySelector('.meta');
    if (meta) meta.textContent = camMeta(cam);
  });
  renderTopbar();
}

function stateLabel(st) {
  return { running: 'en directo', starting: 'conectando…', reconnecting: 'reconectando…',
    stopped: 'detenida', error: 'error' }[st] || st;
}
function camMeta(cam) {
  const h = cam.health || {};
  const parts = [cam.source_type?.toUpperCase()];
  if (h.resolution) parts.push(h.resolution);
  if (h.fps) parts.push(`${h.fps} fps`);
  if (h.last_event_iso) parts.push(`últ. mov. ${timeAgo(h.last_event_iso)}`);
  else if (h.uptime) parts.push(`${fmtDur(h.uptime)} activa`);
  return parts.join(' · ');
}

function renderDashboard() {
  const view = $('#view');
  if (!state.cameras.length) {
    view.innerHTML = `<div class="panel empty">
      <span class="big">📷</span>
      <p>Todavía no hay cámaras configuradas.</p>
      <button class="btn primary" id="empty-add">+ Añadir mi primera cámara</button>
      <p class="muted" style="margin-top:14px">¿Quieres ver cómo funciona antes de conectar nada?
      crea una cámara de <b>tipo demo</b> y tendrás vídeo, detección y eventos al instante.</p>
    </div>`;
    $('#empty-add').onclick = () => cameraWizard();
    return;
  }
  const groups = {};
  state.cameras.forEach(c => { (groups[c.group || 'General'] ||= []).push(c); });

  view.innerHTML = Object.entries(groups).map(([group, cams]) => `
    <div class="section-title">${esc(group)}</div>
    <div class="grid cams">${cams.map(camCard).join('')}</div>
  `).join('');

  $$('[data-cam]').forEach(card => {
    card.querySelector('.feed').onclick = () => { location.hash = '#/camera/' + card.dataset.cam; };
    const toggle = card.querySelector('[data-toggle]');
    toggle.onclick = e => e.stopPropagation();
    toggle.onchange = async e => {
      const id = card.dataset.cam;
      try {
        await api(`/cameras/${id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
        toast(e.target.checked ? 'Cámara activada' : 'Cámara desactivada');
        refresh(true);
      } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
    };
    card.querySelector('[data-act="settings"]').onclick = e => { e.stopPropagation(); cameraSettings(card.dataset.cam); };
    card.querySelector('[data-act="record"]').onclick = async e => {
      e.stopPropagation();
      await api(`/cameras/${card.dataset.cam}/record?seconds=60`, { method: 'POST' });
      toast('Grabando 60 s');
    };
    card.querySelector('[data-act="snap"]').onclick = e => {
      e.stopPropagation();
      openModal('Instantánea', `<img src="/api/stream/${card.dataset.cam}/snapshot.jpg?force=true&t=${Date.now()}"
        style="width:100%;border-radius:10px">`, { wide: true });
    };
  });
}

function camCard(cam) {
  const st = cam.health?.state || 'stopped';
  const rec = !!cam.health?.recording;
  return `
  <div class="cam" data-cam="${cam.id}">
    <div class="feed" id="feed-${cam.id}">
      <img src="/api/stream/${cam.id}/live.mjpg" alt="${esc(cam.name)}" loading="lazy">
      <div class="overlay"></div>
      <div class="tag">
        <span class="badge state ${st}">${stateLabel(st)}</span>
        <span class="badge rec" style="display:${rec ? 'flex' : 'none'}">● REC</span>
      </div>
      <span class="motion">MOVIMIENTO</span>
    </div>
    <div class="caminfo">
      <div>
        <div class="name">${esc(cam.name)}</div>
        <div class="meta">${camMeta(cam)}</div>
      </div>
      <label class="switch" title="Activar/desactivar cámara">
        <input type="checkbox" data-toggle="${cam.id}" ${cam.enabled ? 'checked' : ''}>
        <span class="track"></span>
      </label>
    </div>
    <div class="cambtns">
      <button class="btn sm" data-act="settings">Ajustes</button>
      <button class="btn sm" data-act="snap">Instantánea</button>
      <button class="btn sm" data-act="record">Grabar 60 s</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Vista de cámara                                                     */
/* ------------------------------------------------------------------ */
async function renderCamera() {
  const id = state.cameraId;
  const cam = state.cameras.find(c => c.id === id);
  if (!cam) { location.hash = '#/dashboard'; return; }
  const events = await api(`/events?camera_id=${id}&limit=12`);

  $('#view').innerHTML = `
  <div class="spread" style="margin-bottom:12px">
    <div>
      <h2 style="font-size:19px">${esc(cam.name)}</h2>
      <div class="muted">${esc(cam.group || 'General')} · ${stateLabel(cam.health?.state || 'stopped')}
        · ${esc(cam.health?.resolution || '')}</div>
    </div>
    <div class="row">
      <button class="btn ghost" id="cam-back">← Volver</button>
      <button class="btn" id="cam-settings">Ajustes</button>
      <button class="btn primary" id="cam-record">● Grabar 60 s</button>
    </div>
  </div>

  <div class="detail">
    <div>
      <div class="player"><img id="live" src="/api/stream/${id}/live.mjpg" alt="directo"></div>
      <div class="panel" style="margin-top:14px">
        <div class="spread">
          <h3>Controles</h3>
          <div class="row">
            <label class="switch"><input type="checkbox" id="det-on" ${cam.detection?.enabled ? 'checked' : ''}><span class="track"></span></label>
            <span class="muted">Detección de movimiento</span>
          </div>
        </div>
        <div class="divider"></div>
        <div class="form-grid">
          <div class="field">
            <label>Sensibilidad: <b id="sens-val">${cam.detection?.sensitivity ?? 55}</b></label>
            <input type="range" id="sens" min="1" max="100" value="${cam.detection?.sensitivity ?? 55}">
            <span class="hint">Más alto = detecta cambios más sutiles.</span>
          </div>
          <div class="field">
            <label>Tamaño mínimo (px²): <b id="area-val">${cam.detection?.min_area ?? 1200}</b></label>
            <input type="range" id="area" min="100" max="15000" step="100" value="${cam.detection?.min_area ?? 1200}">
            <span class="hint">Ignora movimientos pequeños (hojas, insectos).</span>
          </div>
          <div class="field">
            <label>Grabación</label>
            <select id="rec-mode">
              <option value="continuous" ${cam.recording?.mode === 'continuous' ? 'selected' : ''}>Continua (24/7 por segmentos)</option>
              <option value="motion" ${cam.recording?.mode === 'motion' ? 'selected' : ''}>Sólo cuando hay movimiento</option>
              <option value="off" ${cam.recording?.mode === 'off' ? 'selected' : ''}>No grabar</option>
            </select>
          </div>
          <div class="field">
            <label>Espera entre eventos (s)</label>
            <input type="number" id="cooldown" min="0" max="600" value="${cam.detection?.cooldown_seconds ?? 20}">
          </div>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn" id="btn-zones">🗺️ Editar zonas de detección</button>
          <button class="btn" id="btn-save-det">Guardar cambios</button>
          <button class="btn ghost" id="btn-restart">Reiniciar cámara</button>
        </div>
      </div>
    </div>

    <div>
      ${cam.onvif?.enabled ? ptzPanel(cam) : ''}
      <div class="panel">
        <div class="spread"><h3>Últimos eventos</h3>
          <button class="btn sm ghost" id="cam-all-events">Ver todos</button></div>
        <div class="list" style="margin-top:10px">
          ${events.events.length ? events.events.map(evItem).join('') : '<div class="empty">Sin eventos todavía</div>'}
        </div>
      </div>
    </div>
  </div>`;

  $('#cam-back').onclick = () => { location.hash = '#/dashboard'; };
  $('#cam-settings').onclick = () => cameraSettings(id);
  $('#cam-record').onclick = async () => {
    await api(`/cameras/${id}/record?seconds=60`, { method: 'POST' });
    toast('Grabando 60 s');
  };
  $('#cam-all-events').onclick = () => { location.hash = '#/events'; };
  $('#btn-restart').onclick = async () => {
    await api(`/cameras/${id}/restart`, { method: 'POST' });
    toast('Cámara reiniciándose');
  };
  $('#sens').oninput = e => { $('#sens-val').textContent = e.target.value; };
  $('#area').oninput = e => { $('#area-val').textContent = e.target.value; };
  $('#btn-zones').onclick = () => zoneEditor(cam);
  $('#btn-save-det').onclick = async () => {
    await api(`/cameras/${id}`, {
      method: 'PATCH',
      body: {
        detection: {
          enabled: $('#det-on').checked,
          sensitivity: +$('#sens').value,
          min_area: +$('#area').value,
          cooldown_seconds: +$('#cooldown').value,
        },
        recording: { mode: $('#rec-mode').value },
      },
    });
    toast('Cambios guardados');
    refresh(true);
  };
  $('#det-on').onchange = () => {};
  wireEvents();
  if (cam.onvif?.enabled) wirePtz(cam);
}

function ptzPanel(cam) {
  return `<div class="panel">
    <h3>Control PTZ</h3>
    <div class="ptz">
      <span></span>
      <button data-ptz="0,0.5" title="Arriba">↑</button>
      <button data-ptz="0,-1" title="Zoom +">＋</button>
      <button data-ptz="-0.5,0" title="Izquierda">←</button>
      <button class="center" data-ptz="stop">■</button>
      <button data-ptz="0.5,0" title="Derecha">→</button>
      <span></span>
      <button data-ptz="0,-0.5" title="Abajo">↓</button>
      <button data-ptz="0,1" title="Zoom -">－</button>
    </div>
    <div class="row">
      <select id="presets"><option value="">Presets…</option></select>
      <button class="btn sm" id="btn-gopreset">Ir</button>
      <button class="btn sm ghost" id="btn-home">Posición inicial</button>
    </div>
  </div>`;
}

function wirePtz(cam) {
  $$('[data-ptz]').forEach(btn => {
    btn.onclick = async () => {
      const raw = btn.dataset.ptz;
      try {
        if (raw === 'stop') await api(`/cameras/${cam.id}/ptz`, { method: 'POST', body: { action: 'stop' } });
        else {
          const [pan, tilt] = raw.split(',').map(Number);
          await api(`/cameras/${cam.id}/ptz`, {
            method: 'POST',
            body: { action: 'move', pan: pan * 0.6, tilt: -tilt * 0.6, zoom: Math.abs(tilt) === 1 ? tilt : 0, duration: 0.5 },
          });
        }
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  $('#btn-home').onclick = () => api(`/cameras/${cam.id}/ptz`, { method: 'POST', body: { action: 'home' } })
    .then(() => toast('Yendo a la posición inicial')).catch(e => toast(e.message, 'err'));
  $('#btn-gopreset').onclick = () => {
    const token = $('#presets').value;
    if (token) api(`/cameras/${cam.id}/ptz`, { method: 'POST', body: { action: 'preset', preset: token } })
      .catch(e => toast(e.message, 'err'));
  };
  api(`/cameras/${cam.id}/ptz/presets`).then(data => {
    const sel = $('#presets');
    if (!sel) return;
    (data.presets || []).forEach(p => {
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(p.token)}">${esc(p.name)}</option>`);
    });
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Editor de zonas                                                     */
/* ------------------------------------------------------------------ */
function zoneEditor(cam) {
  const zones = JSON.parse(JSON.stringify(cam.detection?.zones || []));
  const mode = cam.detection?.zone_mode || 'include';
  openModal('Zonas de detección', `
    <p class="muted">Haz clic sobre la imagen para añadir vértices. Cierra el polígono con
      <b>Cerrar zona</b>. Puedes dibujar varias zonas.</p>
    <div class="row" style="margin:10px 0">
      <label class="switch"><input type="checkbox" id="zone-excl" ${mode === 'exclude' ? 'checked' : ''}><span class="track"></span></label>
      <span>${mode === 'exclude' ? 'Excluir: ignora lo que pase dentro de las zonas' : 'Incluir: sólo detecta dentro de las zonas'}</span>
    </div>
    <div class="zone-editor"><canvas id="zone-canvas"></canvas></div>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="zone-close">Cerrar zona</button>
      <button class="btn ghost" id="zone-undo">Quitar último punto</button>
      <button class="btn danger" id="zone-clear">Borrar todo</button>
      <span class="muted" id="zone-count"></span>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" id="zone-cancel">Cancelar</button>
      <button class="btn primary" id="zone-save">Guardar zonas</button>
    </div>`, { wide: true });

  const canvas = $('#zone-canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  let current = [];

  img.onload = () => {
    canvas.width = img.width; canvas.height = img.height;
    draw();
  };
  img.src = `/api/stream/${cam.id}/snapshot.jpg?force=true&t=` + Date.now();
  img.onerror = () => { toast('No se pudo cargar la imagen de la cámara', 'err'); };

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const poly = pts => pts.map(p => [p[0] * canvas.width, p[1] * canvas.height]);
    zones.forEach(z => {
      const p = poly(z);
      if (p.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      p.slice(1).forEach(pt => ctx.lineTo(pt[0], pt[1]));
      ctx.closePath();
      ctx.fillStyle = 'rgba(61,220,151,.18)';
      ctx.strokeStyle = '#3ddc97';
      ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    });
    if (current.length) {
      const p = poly(current);
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      p.slice(1).forEach(pt => ctx.lineTo(pt[0], pt[1]));
      ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 2; ctx.stroke();
      p.forEach(pt => { ctx.beginPath(); ctx.arc(pt[0], pt[1], 4, 0, 7); ctx.fillStyle = '#ffb454'; ctx.fill(); });
    }
    $('#zone-count').textContent = `${zones.length} zona(s), ${current.length} punto(s) en curso`;
  }

  canvas.onclick = e => {
    const r = canvas.getBoundingClientRect();
    current.push([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
    draw();
  };
  $('#zone-close').onclick = () => { if (current.length >= 3) { zones.push(current); current = []; draw(); } else toast('Necesitas al menos 3 puntos', 'warn'); };
  $('#zone-undo').onclick = () => { current.pop(); draw(); };
  $('#zone-clear').onclick = () => { zones.length = 0; current = []; draw(); };
  $('#zone-cancel').onclick = closeModal;
  $('#zone-save').onclick = async () => {
    try {
      await api(`/cameras/${cam.id}`, {
        method: 'PATCH',
        body: { detection: { zones, zone_mode: $('#zone-excl').checked ? 'exclude' : 'include' } },
      });
      toast('Zonas guardadas');
      closeModal(); refresh(true);
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */
async function renderEvents() {
  const f = state.filters;
  const qs = new URLSearchParams({ limit: 200 });
  if (f.evCamera) qs.set('camera_id', f.evCamera);
  if (f.evLabel) qs.set('label', f.evLabel);
  if (f.evUnack) qs.set('unacknowledged', 'true');
  const data = await api('/events?' + qs);
  state.events = data.events || [];

  const summary = await api('/events/summary');
  const labels = Object.keys(summary.by_label || {});

  $('#view').innerHTML = `
  <div class="panel">
    <div class="spread">
      <div class="row">
        <select id="ev-cam"><option value="">Todas las cámaras</option>
          ${state.cameras.map(c => `<option value="${c.id}" ${f.evCamera === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <select id="ev-label"><option value="">Todo tipo</option>
          ${labels.map(l => `<option value="${l}" ${f.evLabel === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <label class="checkline"><input type="checkbox" id="ev-unack" ${f.evUnack ? 'checked' : ''}> sólo sin revisar</label>
      </div>
      <div class="row">
        <span class="muted">${summary.total} eventos · ${summary.unacknowledged} sin revisar</span>
        <button class="btn sm" id="ev-ackall">Revisar todos</button>
        <button class="btn sm danger" id="ev-clear">Vaciar</button>
      </div>
    </div>
  </div>

  <div class="list" style="margin-top:14px">
    ${state.events.length ? state.events.map(evItem).join('') : '<div class="empty"><span class="big">🔔</span>Sin eventos que mostrar</div>'}
  </div>`;

  $('#ev-cam').onchange = e => { state.filters.evCamera = e.target.value; renderEvents(); };
  $('#ev-label').onchange = e => { state.filters.evLabel = e.target.value; renderEvents(); };
  $('#ev-unack').onchange = e => { state.filters.evUnack = e.target.checked; renderEvents(); };
  $('#ev-ackall').onclick = async () => {
    await Promise.all(state.events.filter(e => !e.acknowledged).map(e => api(`/events/${e.id}/ack`, { method: 'POST', body: { value: true } })));
    toast('Eventos marcados como revisados'); renderEvents();
  };
  $('#ev-clear').onclick = () => confirmModal('Vaciar eventos', 'Se borrará el historial de eventos (las grabaciones no se borran).', async () => {
    await api('/events/clear', { method: 'POST', body: { camera_id: null } });
    renderEvents();
  });
  wireEvents();
}

function evItem(ev) {
  const label = ev.label || 'motion';
  return `<div class="item" data-ev="${ev.id}">
    <img class="thumb" src="/api/events/${ev.id}/snapshot.jpg" data-play="${ev.id}" alt="">
    <div class="grow">
      <div class="title">${esc(ev.camera_name || 'Cámara')} · <span class="tag ${esc(label)}">${esc(label)}</span></div>
      <div class="meta">
        <span>${fmtTime(ev.ts)}</span><span>${timeAgo(ev.ts)}</span>
        <span>${ev.score ?? 0}% imagen</span>
        ${ev.notified?.length ? `<span>📤 ${esc(ev.notified.join(', '))}</span>` : ''}
        ${ev.acknowledged ? '<span>✓ revisado</span>' : ''}
      </div>
    </div>
    <div class="row">
      ${ev.clip ? `<button class="btn sm" data-playclip="${esc(ev.clip)}">▶ Clip</button>` : ''}
      ${ev.acknowledged ? '' : `<button class="btn sm" data-ack="${ev.id}">Revisar</button>`}
      <button class="btn sm ghost" data-delev="${ev.id}">🗑</button>
    </div>
  </div>`;
}

function wireEvents() {
  $$('[data-play]').forEach(el => el.onclick = () => eventModal(el.dataset.play));
  $$('[data-playclip]').forEach(el => el.onclick = () => videoModal(el.dataset.playclip, 'Clip del evento'));
  $$('[data-ack]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    await api(`/events/${el.dataset.ack}/ack`, { method: 'POST', body: { value: true } });
    const view = state.view;
    view === 'events' ? renderEvents() : refresh(true);
  });
  $$('[data-delev]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    await api(`/events/${el.dataset.delev}`, { method: 'DELETE' });
    render();
  });
}

function eventModal(id) {
  const ev = state.events.find(e => e.id === id) || null;
  openModal('Evento', `
    <div class="video-wrap"><img src="/api/events/${id}/snapshot.jpg" style="width:100%;display:block"></div>
    <div class="row" style="margin-top:12px">
      <span class="tag ${esc(ev?.label || '')}">${esc(ev?.label || 'motion')}</span>
      <span class="muted">${fmtTime(ev?.ts || '')}</span>
      <span class="muted">${esc(ev?.camera_name || '')}</span>
    </div>
    ${ev?.clip ? `<div class="row" style="margin-top:10px">
      <button class="btn primary" data-clip="${esc(ev.clip)}">▶ Ver clip</button></div>` : ''}
  `, { wide: true });
  const clipBtn = $('[data-clip]', $('#modal-body'));
  if (clipBtn) clipBtn.onclick = () => videoModal(clipBtn.dataset.clip, 'Clip del evento');
}

function videoModal(path, title) {
  openModal(title || 'Grabación', `
    <div class="video-wrap">
      <video controls autoplay playsinline src="/api/recordings/play?path=${encodeURIComponent(path)}"></video>
    </div>
    <div class="row" style="margin-top:12px;justify-content:flex-end">
      <a class="btn" href="/api/recordings/download?path=${encodeURIComponent(path)}">⬇ Descargar</a>
      <button class="btn danger" data-del="${esc(path)}">🗑 Borrar</button>
    </div>`, { wide: true });
  $('[data-del]', $('#modal-body')).onclick = async e => {
    await api('/recordings?path=' + encodeURIComponent(e.target.dataset.del), { method: 'DELETE' });
    toast('Grabación borrada'); closeModal(); render();
  };
}

async function checkNewEvents() {
  try {
    const data = await api('/events?limit=1');
    const ev = (data.events || [])[0];
    if (!ev) return;
    const unack = data.unacknowledged ?? 0;
    const pill = $('#events-pill');
    pill.textContent = unack;
    pill.classList.toggle('show', unack > 0);
    if (state.lastEventTs && ev.ts !== state.lastEventTs) {
      const card = document.querySelector(`[data-cam="${ev.camera_id}"] .feed`);
      if (card) {
        card.classList.add('motion-alert', 'flash');
        setTimeout(() => card.classList.remove('motion-alert'), 7000);
      }
    }
    state.lastEventTs = ev.ts;
  } catch { /* silencioso */ }
}

/* ------------------------------------------------------------------ */
/* Grabaciones                                                         */
/* ------------------------------------------------------------------ */
async function renderRecordings() {
  const f = state.filters;
  const qs = new URLSearchParams({ limit: 400 });
  if (f.recCamera) qs.set('camera_id', f.recCamera);
  if (f.recDate) qs.set('date', f.recDate);
  if (f.recKind) qs.set('kind', f.recKind);
  const data = await api('/recordings?' + qs);
  state.recordings = data.items || [];
  const cal = await api('/recordings/calendar?days=31' + (f.recCamera ? `&camera_id=${f.recCamera}` : ''));
  const st = data.storage;

  $('#view').innerHTML = `
  <div class="panel">
    <div class="spread">
      <div class="row">
        <select id="rec-cam"><option value="">Todas las cámaras</option>
          ${state.cameras.map(c => `<option value="${c.id}" ${f.recCamera === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <input type="date" id="rec-date" value="${f.recDate}" style="width:auto">
        <select id="rec-kind" style="width:auto">
          <option value="">Todo</option>
          <option value="segment" ${f.recKind === 'segment' ? 'selected' : ''}>Grabación continua</option>
          <option value="clip" ${f.recKind === 'clip' ? 'selected' : ''}>Clips por movimiento</option>
        </select>
        ${f.recDate || f.recCamera || f.recKind ? '<button class="btn sm ghost" id="rec-reset">Quitar filtros</button>' : ''}
      </div>
      <div class="row">
        <span class="muted">${data.total} ficheros · ${fmtBytes(st.recordings.bytes + st.clips.bytes)} · libre ${fmtBytes(st.disk.free)}</span>
        <button class="btn sm danger" id="rec-prune">Limpiar antiguas</button>
      </div>
    </div>
    <div class="row" style="margin-top:12px;gap:6px">
      ${(cal.days || []).slice(0, 14).map(d => `
        <button class="btn sm ${f.recDate === d.date ? 'primary' : 'ghost'}" data-date="${d.date}">
          ${d.date.slice(8)}/${d.date.slice(5, 7)} <span class="muted">${d.segments + d.clips}</span>
        </button>`).join('')}
    </div>
  </div>

  <div class="list" style="margin-top:14px">
    ${state.recordings.length ? state.recordings.map(recItem).join('')
      : '<div class="empty"><span class="big">📼</span>No hay grabaciones para este filtro</div>'}
  </div>`;

  $('#rec-cam').onchange = e => { state.filters.recCamera = e.target.value; renderRecordings(); };
  $('#rec-date').onchange = e => { state.filters.recDate = e.target.value; renderRecordings(); };
  $('#rec-kind').onchange = e => { state.filters.recKind = e.target.value; renderRecordings(); };
  const reset = $('#rec-reset');
  if (reset) reset.onclick = () => { state.filters.recCamera = ''; state.filters.recDate = ''; state.filters.recKind = ''; renderRecordings(); };
  $$('[data-date]').forEach(b => b.onclick = () => {
    state.filters.recDate = state.filters.recDate === b.dataset.date ? '' : b.dataset.date;
    renderRecordings();
  });
  $('#rec-prune').onclick = () => confirmModal('Limpiar grabaciones antiguas',
    'Se borrarán las grabaciones más viejas que el período de retención configurado.', async () => {
      const r = await api('/recordings/prune', { method: 'POST', body: {} });
      toast(`Liberados ${fmtBytes(r.bytes)} (${r.files} ficheros)`);
      renderRecordings();
    });
  $$('[data-rec]').forEach(el => el.onclick = () => videoModal(el.dataset.rec, el.dataset.name));
}

function recItem(r) {
  return `<div class="item">
    <img class="thumb" src="/api/recordings/thumb?path=${encodeURIComponent(r.path)}" data-rec="${esc(r.path)}" data-name="${esc(r.name)}" loading="lazy">
    <div class="grow">
      <div class="title">${esc(r.camera_name)} <span class="tag">${r.kind === 'clip' ? 'movimiento' : 'continua'}</span></div>
      <div class="meta">
        <span>${fmtTime(r.start)}</span>
        <span>${fmtDur(r.duration)}</span>
        <span>${fmtBytes(r.size)}</span>
      </div>
    </div>
    <div class="row">
      <a class="btn sm" href="/api/recordings/download?path=${encodeURIComponent(r.path)}">⬇</a>
      <button class="btn sm ghost" data-delrec="${esc(r.path)}">🗑</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Ajustes                                                             */
/* ------------------------------------------------------------------ */
async function renderSettings() {
  const s = state.settings;
  const info = state.info;
  $('#view').innerHTML = `
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">

    <div class="panel">
      <h3>💾 Almacenamiento</h3>
      <div class="field"><label>Carpeta de grabaciones</label>
        <input id="st-rec" value="${esc(s.storage?.recordings_dir || '')}"></div>
      <div class="field"><label>Días de retención</label>
        <input type="number" min="1" max="365" id="st-ret" value="${s.storage?.retention_days ?? 14}"></div>
      <div class="field"><label>Límite de espacio (GB, 0 = sin límite)</label>
        <input type="number" min="0" id="st-max" value="${s.storage?.max_storage_gb ?? 100}"></div>
      <div class="muted">Uso actual: ${fmtBytes(info.storage?.recordings?.bytes || 0)} en grabaciones,
        ${fmtBytes(info.storage?.snapshots?.bytes || 0)} en instantáneas.
        Libre en disco: ${fmtBytes(info.storage?.disk?.free || 0)}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="st-save">Guardar</button>
        <button class="btn" id="st-prune">Limpiar ahora</button>
      </div>
    </div>

    <div class="panel">
      <h3>🔔 Notificaciones</h3>
      <label class="checkline"><input type="checkbox" id="nt-on" ${s.notifications?.enabled ? 'checked' : ''}> Activar notificaciones</label>
      <div class="field"><label>Espera mínima entre avisos (s)</label>
        <input type="number" min="0" id="nt-cool" value="${s.notifications?.cooldown_seconds ?? 60}"></div>
      <label class="checkline"><input type="checkbox" id="nt-img" ${s.notifications?.attach_snapshot ? 'checked' : ''}> Adjuntar imagen del evento</label>

      <div class="divider"></div>
      <h4>Telegram</h4>
      <label class="checkline"><input type="checkbox" id="tg-on" ${s.notifications?.telegram?.enabled ? 'checked' : ''}> Activar</label>
      <div class="field"><label>Token del bot</label><input id="tg-token" value="${esc(s.notifications?.telegram?.bot_token || '')}" placeholder="123456:ABC-DEF..."></div>
      <div class="field"><label>Chat ID</label><input id="tg-chat" value="${esc(s.notifications?.telegram?.chat_id || '')}" placeholder="-100123456789"></div>

      <div class="divider"></div>
      <h4>ntfy (recomendado, gratis)</h4>
      <label class="checkline"><input type="checkbox" id="nf-on" ${s.notifications?.ntfy?.enabled ? 'checked' : ''}> Activar</label>
      <div class="field"><label>Servidor</label><input id="nf-server" value="${esc(s.notifications?.ntfy?.server || 'https://ntfy.sh')}"></div>
      <div class="field"><label>Tema (topic)</label><input id="nf-topic" value="${esc(s.notifications?.ntfy?.topic || '')}" placeholder="vigia-casa-xyz123"></div>
      <div class="field"><label>Token (opcional)</label><input id="nf-token" value="${esc(s.notifications?.ntfy?.token || '')}"></div>

      <div class="divider"></div>
      <h4>Webhook / HTTP</h4>
      <label class="checkline"><input type="checkbox" id="wh-on" ${s.notifications?.webhook?.enabled ? 'checked' : ''}> Activar</label>
      <div class="field"><label>URL</label><input id="wh-url" value="${esc(s.notifications?.webhook?.url || '')}" placeholder="https://hooks.ejemplo.com/..."></div>

      <div class="divider"></div>
      <h4>Correo (SMTP)</h4>
      <label class="checkline"><input type="checkbox" id="em-on" ${s.notifications?.email?.enabled ? 'checked' : ''}> Activar</label>
      <div class="form-grid">
        <div class="field"><label>Servidor</label><input id="em-host" value="${esc(s.notifications?.email?.host || '')}"></div>
        <div class="field"><label>Puerto</label><input type="number" id="em-port" value="${s.notifications?.email?.port ?? 587}"></div>
        <div class="field"><label>Usuario</label><input id="em-user" value="${esc(s.notifications?.email?.username || '')}"></div>
        <div class="field"><label>Contraseña</label><input type="password" id="em-pass" value="${esc(s.notifications?.email?.password || '')}"></div>
        <div class="field"><label>Desde</label><input id="em-from" value="${esc(s.notifications?.email?.from || '')}"></div>
        <div class="field"><label>Para</label><input id="em-to" value="${esc(s.notifications?.email?.to || '')}"></div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="nt-save">Guardar</button>
        <button class="btn" id="nt-test">Enviar prueba</button>
      </div>
    </div>

    <div class="panel">
      <h3>🎯 Detección y grabación (por defecto)</h3>
      <div class="form-grid">
        <div class="field"><label>Sensibilidad</label>
          <input type="number" min="1" max="100" id="dt-sens" value="${s.detection?.sensitivity ?? 55}"></div>
        <div class="field"><label>Tamaño mínimo (px²)</label>
          <input type="number" min="0" id="dt-area" value="${s.detection?.min_area ?? 1200}"></div>
        <div class="field"><label>FPS de análisis</label>
          <input type="number" min="1" max="30" id="dt-fps" value="${s.detection?.fps ?? 6}"></div>
        <div class="field"><label>Ancho de análisis (px)</label>
          <input type="number" min="160" id="dt-width" value="${s.detection?.detect_width ?? 640}"></div>
        <div class="field"><label>Espera entre eventos (s)</label>
          <input type="number" min="0" id="dt-cool" value="${s.detection?.cooldown_seconds ?? 20}"></div>
        <div class="field"><label>Modo de grabación</label>
          <select id="rd-mode">
            <option value="continuous" ${s.recording?.mode === 'continuous' ? 'selected' : ''}>Continua</option>
            <option value="motion" ${s.recording?.mode === 'motion' ? 'selected' : ''}>Sólo movimiento</option>
            <option value="off" ${s.recording?.mode === 'off' ? 'selected' : ''}>Desactivada</option>
          </select></div>
        <div class="field"><label>Segmento (s)</label>
          <input type="number" min="10" id="rd-seg" value="${s.recording?.segment_seconds ?? 300}"></div>
        <div class="field"><label>Pre / post grabación (s)</label>
          <div class="row">
            <input type="number" min="0" id="rd-pre" value="${s.recording?.pre_seconds ?? 5}">
            <input type="number" min="1" id="rd-post" value="${s.recording?.post_seconds ?? 10}">
          </div></div>
      </div>
      <div class="divider"></div>
      <h4>Detección con IA (personas, vehículos, mascotas)</h4>
      <p class="muted">Requiere <span class="kbd">pip install ultralytics</span>.
        Estado: <b>${info.ai_available ? 'disponible ✓' : 'no instalada'}</b></p>
      <label class="checkline"><input type="checkbox" id="dt-ai" ${s.detection?.ai_enabled ? 'checked' : ''}> Usar IA para confirmar los eventos</label>
      <div class="field"><label>Modelo</label><input id="dt-model" value="${esc(s.detection?.ai_model || 'yolov8n.pt')}"></div>
      <div class="field"><label>Clases de interés (separadas por coma)</label>
        <input id="dt-labels" value="${esc((s.detection?.ai_labels || []).join(','))}"></div>
      <div class="field"><label>Confianza mínima</label>
        <input type="number" min="0.05" max="0.95" step="0.05" id="dt-conf" value="${s.detection?.ai_confidence ?? 0.45}"></div>
      <button class="btn primary" id="dt-save" style="margin-top:8px">Guardar</button>
    </div>

    <div class="panel">
      <h3>🔒 Seguridad e identidad</h3>
      <div class="field"><label>Nombre del sistema</label><input id="gn-name" value="${esc(s.general?.system_name || 'Vigía')}"></div>
      <label class="checkline"><input type="checkbox" id="gn-auth" ${s.general?.auth_enabled ? 'checked' : ''}>
        Pedir usuario y contraseña al abrir Vigía</label>
      <div class="form-grid">
        <div class="field"><label>Usuario</label><input id="gn-user" value="${esc(s.general?.username || 'admin')}"></div>
        <div class="field"><label>Contraseña nueva</label><input type="password" id="gn-pass" placeholder="(dejar vacío para no cambiar)"></div>
      </div>
      <div class="row"><button class="btn primary" id="gn-save">Guardar</button></div>
      <div class="divider"></div>
      <h3>🩺 Sistema</h3>
      <table>
        <tr><td>Versión</td><td>${esc(info.version)} · Python ${esc(info.python)}</td></tr>
        <tr><td>Equipo</td><td>${esc(info.hostname)} (${esc(info.platform)})</td></tr>
        <tr><td>IP local</td><td>${esc(info.local_ip)}</td></tr>
        <tr><td>ffmpeg</td><td>${info.ffmpeg ? '✓ ' + esc(info.ffmpeg.split('/').pop()) : '✗ no encontrado'}</td></tr>
        <tr><td>OpenCV</td><td>${esc(info.opencv)}</td></tr>
        <tr><td>ONVIF</td><td>${info.onvif_available ? '✓ disponible' : '✗ instala onvif-zeep'}</td></tr>
        <tr><td>IA (YOLO)</td><td>${info.ai_available ? '✓ disponible' : '✗ instala ultralytics'}</td></tr>
        <tr><td>Activo desde</td><td>${fmtDur(info.uptime_seconds)}</td></tr>
      </table>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="sys-export">Exportar configuración</button>
        <button class="btn ghost" id="sys-reload">Recargar del disco</button>
      </div>
    </div>
  </div>`;

  // --- almacenamiento ---
  $('#st-save').onclick = async () => {
    await api('/settings/storage', {
      method: 'PATCH',
      body: {
        recordings_dir: $('#st-rec').value,
        retention_days: +$('#st-ret').value,
        max_storage_gb: +$('#st-max').value,
      },
    });
    toast('Ajustes de almacenamiento guardados'); refresh(true);
  };
  $('#st-prune').onclick = async () => {
    const r = await api('/recordings/prune', { method: 'POST', body: {} });
    toast(`Liberados ${fmtBytes(r.bytes)}`);
  };

  // --- notificaciones ---
  $('#nt-save').onclick = async () => {
    await api('/settings/notifications', {
      method: 'PATCH',
      body: {
        enabled: $('#nt-on').checked,
        cooldown_seconds: +$('#nt-cool').value,
        attach_snapshot: $('#nt-img').checked,
        telegram: { enabled: $('#tg-on').checked, bot_token: $('#tg-token').value, chat_id: $('#tg-chat').value },
        ntfy: { enabled: $('#nf-on').checked, server: $('#nf-server').value, topic: $('#nf-topic').value, token: $('#nf-token').value },
        webhook: { enabled: $('#wh-on').checked, url: $('#wh-url').value },
        email: {
          enabled: $('#em-on').checked, host: $('#em-host').value, port: +$('#em-port').value,
          username: $('#em-user').value, password: $('#em-pass').value,
          from: $('#em-from').value, to: $('#em-to').value,
        },
      },
    });
    toast('Notificaciones guardadas'); refresh(true);
  };
  $('#nt-test').onclick = async () => {
    const r = await api('/settings/notifications/test', { method: 'POST', body: { channel: null } });
    const results = r.results || {};
    const keys = Object.keys(results);
    if (!keys.length) return toast('Ningún canal activo', 'warn');
    keys.forEach(k => toast(`${k}: ${results[k] === 'ok' ? 'enviado ✓' : results[k]}`, results[k] === 'ok' ? '' : 'err'));
  };

  // --- detección ---
  $('#dt-save').onclick = async () => {
    await api('/settings/detection', {
      method: 'PATCH',
      body: {
        sensitivity: +$('#dt-sens').value, min_area: +$('#dt-area').value,
        fps: +$('#dt-fps').value, detect_width: +$('#dt-width').value,
        cooldown_seconds: +$('#dt-cool').value,
        ai_enabled: $('#dt-ai').checked, ai_model: $('#dt-model').value,
        ai_confidence: +$('#dt-conf').value,
        ai_labels: $('#dt-labels').value.split(',').map(s => s.trim()).filter(Boolean),
      },
    });
    await api('/settings/recording', {
      method: 'PATCH',
      body: {
        mode: $('#rd-mode').value, segment_seconds: +$('#rd-seg').value,
        pre_seconds: +$('#rd-pre').value, post_seconds: +$('#rd-post').value,
      },
    });
    toast('Ajustes de detección guardados'); refresh(true);
  };

  // --- general ---
  $('#gn-save').onclick = async () => {
    const body = {
      system_name: $('#gn-name').value,
      auth_enabled: $('#gn-auth').checked,
      username: $('#gn-user').value,
    };
    const pass = $('#gn-pass').value;
    if (pass) body.password = pass;
    await api('/settings/general', { method: 'PATCH', body });
    toast('Guardado' + (pass ? ' (vuelve a entrar con la nueva contraseña)' : ''));
    refresh(true);
  };

  $('#sys-export').onclick = async () => {
    const data = await api('/settings/export', { method: 'POST', body: {} });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vigia-config-${todayStr()}.json`;
    a.click();
  };
  $('#sys-reload').onclick = async () => { await api('/settings/reload', { method: 'POST', body: {} }); refresh(true); toast('Configuración recargada'); };
}

/* ------------------------------------------------------------------ */
/* Asistente de alta de cámaras                                        */
/* ------------------------------------------------------------------ */
function cameraWizard() {
  const st = state.settings;
  openModal('Añadir cámara', `
    <div class="field">
      <label>Tipo de cámara</label>
      <select id="w-type">
        <option value="rtsp">Cámara IP por RTSP (Reolink, Hikvision, Amcrest, Dahua, iCSee/XMEye…)</option>
        <option value="usb">Webcam USB / cámara del portátil</option>
        <option value="file">Fichero de vídeo (para pruebas)</option>
        <option value="demo">Cámara de demostración (sin hardware)</option>
      </select>
    </div>

    <div id="w-discover-box" class="panel" style="background:var(--bg-2)">
      <div class="spread">
        <h4>🔎 Buscar cámaras en la red</h4>
        <div class="row">
          <button class="btn sm" id="w-dis-onvif">Buscar (ONVIF)</button>
          <button class="btn sm" id="w-dis-scan">Escanear red</button>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="w-dis-user" placeholder="usuario" style="width:auto">
        <input id="w-dis-pass" type="password" placeholder="contraseña" style="width:auto">
      </div>
      <div class="row" style="margin-top:8px;gap:6px">
        <input id="w-dis-ip" placeholder="IP de la cámara (p. ej. 192.168.0.108)" style="flex:1">
        <button class="btn sm primary" id="w-dis-diag">🔧 Diagnosticar iCSee</button>
      </div>
      <div id="w-dis-results" class="list" style="margin-top:10px"></div>
    </div>

    <div class="form-grid" style="margin-top:14px">
      <div class="field"><label>Nombre</label><input id="w-name" placeholder="Entrada, Garaje, Salón…"></div>
      <div class="field"><label>Grupo / zona</label><input id="w-group" placeholder="Planta baja"></div>
      <div class="field w-rtsp"><label>URL RTSP (calidad alta, para grabar)</label>
        <input id="w-url" placeholder="rtsp://192.168.1.50:554/Streaming/Channels/101">
        <span class="hint">Cámaras iCSee/XMEye: <code>rtsp://IP:554/user=admin&password=&channel=1&stream=0.sdp?real_stream</code> (credenciales dentro de la ruta). Multi-lente: <code>channel=1</code>, <code>channel=2</code>, <code>channel=3</code>… = cada lente.</span></div>
      <div class="field w-rtsp"><label>URL RTSP secundaria (opcional, para detectar y ver en directo)</label>
        <input id="w-sub" placeholder="rtsp://192.168.1.50:554/Streaming/Channels/102"></div>
      <div class="field w-rtsp"><label>Usuario</label><input id="w-user"></div>
      <div class="field w-rtsp"><label>Contraseña</label><input type="password" id="w-pass"></div>
      <div class="field w-usb" style="display:none"><label>Índice de dispositivo</label>
        <input type="number" id="w-index" value="0" min="0"></div>
      <div class="field w-usb" style="display:none"><label>Nombre del dispositivo (Windows/macOS, opcional)</label>
        <input id="w-devname" placeholder="Logitech HD Webcam C920"></div>
      <div class="field w-file" style="display:none"><label>Ruta del vídeo</label>
        <input id="w-file" placeholder="/ruta/a/video.mp4"></div>
    </div>

    <div class="divider"></div>
    <h4>ONVIF (movimiento, zoom, presets)</h4>
    <label class="checkline"><input type="checkbox" id="w-onvif"> Configurar ONVIF (host, puerto y credenciales)</label>
    <p class="hint" style="margin:6px 0 0">Cámaras iCSee/XMEye: puerto <b>8899</b> y credenciales <code>admin</code>/vacía (no las de la app). Requiere <code>pip install onvif-zeep</code>.</p>
    <div id="w-onvif-box" style="display:none" class="form-grid">
      <div class="field"><label>Host ONVIF</label><input id="w-ov-host" placeholder="192.168.1.50"></div>
      <div class="field"><label>Puerto</label><input type="number" id="w-ov-port" value="80"></div>
      <div class="field"><label>Usuario</label><input id="w-ov-user"></div>
      <div class="field"><label>Contraseña</label><input type="password" id="w-ov-pass"></div>
      <div class="field"><label>Perfil (token)</label><input id="w-ov-token" placeholder="(vacío = el primero)"></div>
    </div>

    <div id="w-preview" style="margin-top:12px"></div>

    <div class="row" style="justify-content:flex-end;margin-top:16px;gap:8px">
      <button class="btn ghost" id="w-cancel">Cancelar</button>
      <button class="btn" id="w-test">Probar conexión</button>
      <button class="btn primary" id="w-save">Guardar cámara</button>
    </div>`, { wide: true });

  const typeSel = $('#w-type');
  const syncType = () => {
    const t = typeSel.value;
    $$('.w-rtsp').forEach(e => e.style.display = t === 'rtsp' ? '' : 'none');
    $$('.w-usb').forEach(e => e.style.display = t === 'usb' ? '' : 'none');
    $$('.w-file').forEach(e => e.style.display = t === 'file' ? '' : 'none');
    $('#w-discover-box').style.display = t === 'rtsp' ? '' : 'none';
  };
  typeSel.onchange = syncType; syncType();

  $('#w-onvif').onchange = e => { $('#w-onvif-box').style.display = e.target.checked ? '' : 'none'; };
  $('#w-cancel').onclick = closeModal;

  // ---- autodescubrimiento ----
  // Detecta si una URL es de una cámara iCSee/XMEye (credenciales en la ruta).
  function isIcseeUrl(u) {
    return /user=[^&/?\s]*&password=/i.test(u) || /user=[^_?\s]*_password=/i.test(u);
  }
  // Extrae host y credenciales de una URL iCSee/XMEye (user=..&password=..).
  function icseeInfo(u) {
    let host = '';
    try { host = new URL(u).hostname; } catch {}
    const um = /(?:^|[?&_/])user=([^&_?\s]*)/i.exec(u);
    const pm = /(?:^|[?&_])password=([^&_?\s]*)/i.exec(u);
    return { host, username: um ? decodeURIComponent(um[1]) : '', password: pm ? decodeURIComponent(pm[1]) : '' };
  }

  // Agrupa las URLs RTSP por canal (channel=N) y separa principal/secundario.
  // Las cámaras multi-lente (iCSee/XMEye) devuelven una URL por lente.
  // El canal 0, si responde, es la vista combinada (mosaico).
  function parseChannelUrls(urls) {
    const groups = new Map();
    const leftover = [];
    for (const u of urls) {
      const chm = /[?&_]channel=(\d+)/i.exec(u);
      if (!chm) { leftover.push(u); continue; }
      const stm = /[?&_]stream=(\d+)/i.exec(u);
      const isSub = !!(stm && stm[1] === '1');
      const key = chm[1];
      if (!groups.has(key)) groups.set(key, { channel: chm[1], main: '', sub: '', mosaic: chm[1] === '0' });
      const g = groups.get(key);
      if (isSub) { if (!g.sub) g.sub = u; }
      else if (!g.main) g.main = u;
    }
    const sorted = [...groups.values()].sort((a, b) => Number(a.channel) - Number(b.channel));
    return { groups: sorted, leftover };
  }

  function onvifConfigFor(url) {
    const info = icseeInfo(url);
    return {
      enabled: true,
      host: info.host,
      port: 8899,               // iCSee/XMEye expone ONVIF en 8899
      username: info.username,
      password: info.password,
      profile_token: '',
    };
  }

  // Crea una cámara por cada canal/lente detectado. Las URLs ya traen las
  // credenciales embebidas (user=..&password=..), así que no las pisamos.
  // Para cámaras iCSee/XMEye activa ONVIF (puerto 8899) para mover/zoom (PTZ).
  async function addAllChannels(groups) {
    const base = $('#w-name').value.trim() || 'Cámara';
    const grp = $('#w-group').value.trim() || 'General';
    const icsee = groups.some(g => isIcseeUrl(g.main || g.sub));
    let added = 0;
    for (const g of groups) {
      const url = g.main || g.sub || '';
      const payload = {
        name: g.mosaic ? `${base} · mosaico` : `${base} · lente ${g.channel}`,
        group: grp,
        source_type: 'rtsp',
        url,
        substream_url: g.sub || '',
      };
      if (icsee) payload.onvif = onvifConfigFor(url);
      try {
        await api('/cameras', { method: 'POST', body: payload });
        added++;
      } catch (e) { toast(`${g.mosaic ? 'Mosaico' : 'Lente ' + g.channel}: ${e.message}`, 'err'); }
    }
    if (added) {
      toast(`${added} cámaras añadidas${icsee ? ' (ONVIF/PTZ configurado en puerto 8899)' : ''}`);
      closeModal();
      await refresh(true);
      location.hash = '#/dashboard';
    }
  }

  async function discover(mode, target = '') {
    const box = $('#w-dis-results');
    box.innerHTML = '<div class="muted"><span class="spinner"></span> Buscando dispositivos…</div>';
    try {
      const data = await api('/system/discover', {
        method: 'POST',
        body: {
          mode, target,
          username: $('#w-dis-user').value,
          password: $('#w-dis-pass').value,
        },
      });
      if (mode === 'rtsp') {
        const urls = data.urls || [];
        const { groups, leftover } = parseChannelUrls(urls);
        const lensGroups = groups.filter(g => !g.mosaic);
        const mosaic = groups.find(g => g.mosaic);
        const icsee = groups.some(g => isIcseeUrl(g.main || g.sub));
        let html = '';
        if (lensGroups.length > 1) {
          html += `<div class="item" style="border-left:3px solid var(--accent,#3ddc97)">
            <div class="grow">
              <div class="title">📷 Cámara multi-lente (${lensGroups.length} canales)</div>
              <div class="meta">Cada lente se añadirá como una cámara independiente${icsee ? ' · PTZ vía ONVIF (8899)' : ''}.</div>
            </div>
            <button class="btn sm primary" id="w-add-channels">➕ Añadir los ${lensGroups.length}</button>
          </div>`;
        }
        html += lensGroups.map(g => `
          <div class="item"><div class="grow">
            <div class="title" style="font-size:12px">Lente ${esc(g.channel)}</div>
            <div class="meta" style="font-size:11px;word-break:break-all">${esc(g.main || g.sub)}</div>
          </div>
          <button class="btn sm" data-url="${esc(g.main || '')}" data-sub="${esc(g.sub || '')}">Usar</button></div>`).join('');
        if (mosaic) {
          html += `<div class="item" style="border-left:3px solid var(--accent,#3ddc97)">
            <div class="grow">
              <div class="title" style="font-size:12px">🧩 Mosaico (todas las lentes en una imagen)</div>
              <div class="meta" style="font-size:11px;word-break:break-all">${esc(mosaic.main || mosaic.sub)}</div>
            </div>
            <button class="btn sm" data-url="${esc(mosaic.main || '')}" data-sub="${esc(mosaic.sub || '')}">Usar</button></div>`;
        }
        html += leftover.map(u => `
          <div class="item"><div class="grow"><div class="title" style="font-size:12px;word-break:break-all">${esc(u)}</div></div>
            <button class="btn sm" data-url="${esc(u)}" data-sub="">Usar</button></div>`).join('');
        box.innerHTML = html || '<div class="muted">Sin resultados.</div>';
        const addBtn = $('#w-add-channels', box);
        if (addBtn) addBtn.onclick = () => addAllChannels(groups);
      } else {
        box.innerHTML = (data.devices || []).map(d => `
          <div class="item"><div class="grow">
              <div class="title">${esc(d.name || d.ip)}</div>
              <div class="meta"><span>${esc(d.ip)}</span>${(d.ports || []).length ? `<span>puertos ${esc((d.ports || []).join(','))}</span>` : ''}
              ${d.hardware ? `<span>${esc(d.hardware)}</span>` : ''}</div>
              ${(d.rtsp_candidates || []).map(u => `<div class="meta" style="margin-top:4px"><button class="btn sm" data-url="${esc(u)}">${esc(u)}</button></div>`).join('')}
            </div>
            <button class="btn sm" data-probe="${esc(d.ip)}">Sondear RTSP</button>
          </div>`).join('') || '<div class="muted">No se han encontrado dispositivos.</div>';
      }
      $$('[data-url]', box).forEach(b => b.onclick = () => {
        $('#w-url').value = b.dataset.url;
        if (b.dataset.sub) $('#w-sub').value = b.dataset.sub;
        // Si es iCSee/XMEye, precarga ONVIF (puerto 8899) para mover/zoom.
        if (isIcseeUrl(b.dataset.url)) {
          const info = icseeInfo(b.dataset.url);
          $('#w-onvif').checked = true;
          $('#w-onvif-box').style.display = '';
          $('#w-ov-host').value = info.host;
          $('#w-ov-port').value = 8899;
          if (!info.username) { $('#w-ov-user').value = ''; $('#w-ov-pass').value = ''; }
          toast('URL y ONVIF (8899) puestos en el formulario');
        } else {
          toast('URL puesta en el formulario');
        }
      });
      $$('[data-probe]', box).forEach(b => b.onclick = () => discover('rtsp', b.dataset.probe));
    } catch (e) {
      box.innerHTML = `<div class="muted">Error: ${esc(e.message)}</div>`;
    }
  }
  $('#w-dis-onvif').onclick = () => discover('onvif');
  $('#w-dis-scan').onclick = () => discover('scan');

  // ---- diagnóstico de una IP (iCSee / XMEye) ----
  async function diagnose() {
    const box = $('#w-dis-results');
    const ip = $('#w-dis-ip').value.trim();
    if (!ip) { toast('Escribe la IP de la cámara', 'warn'); return; }
    box.innerHTML = '<div class="muted"><span class="spinner"></span> Analizando ' + esc(ip) + '…</div>';
    try {
      const r = await api('/system/diagnose', {
        method: 'POST',
        body: { mode: 'diagnose', target: ip, username: $('#w-dis-user').value, password: $('#w-dis-pass').value },
      });
      const ports = (r.ports || []);
      const openPorts = ports.filter(p => p.open);
      let html = '<div class="item" style="border-left:3px solid var(--accent,#3ddc97)">' +
        '<div class="grow"><div class="title">🔧 Diagnóstico de ' + esc(ip) + '</div>' +
        '<div class="meta">' + (openPorts.length
          ? openPorts.map(p => `puerto <b>${p.port}</b> ${p.label ? '· ' + esc(p.label) : ''}`).join(' · ')
          : 'ningún puerto abierto') + '</div></div></div>';
      const urls = (r.rtsp || []);
      if (urls.length) {
        html += `<div class="item"><div class="grow"><div class="title">✅ RTSP disponible (${urls.length})</div>` +
          urls.map(u => `<div class="meta" style="word-break:break-all"><button class="btn sm" data-url="${esc(u)}">Usar · ${esc(u)}</button></div>`).join('') +
          '</div></div>';
      } else {
        html += '<div class="item"><div class="grow"><div class="title" style="color:#ff6b6b">❌ RTSP sin respuesta</div></div></div>';
      }
      (r.hints || []).forEach(h => { html += `<div class="item"><div class="grow"><div class="meta">💡 ${esc(h)}</div></div></div>`; });
      box.innerHTML = html;
      $$('[data-url]', box).forEach(b => b.onclick = () => {
        $('#w-url').value = b.dataset.url;
        if (isIcseeUrl(b.dataset.url)) {
          const info = icseeInfo(b.dataset.url);
          $('#w-onvif').checked = true;
          $('#w-onvif-box').style.display = '';
          $('#w-ov-host').value = info.host;
          $('#w-ov-port').value = 8899;
          toast('URL RTSP puesta en el formulario');
        } else {
          $('#w-url').value = b.dataset.url;
          toast('URL puesta en el formulario');
        }
      });
    } catch (e) {
      box.innerHTML = `<div class="muted">Error: ${esc(e.message)}</div>`;
    }
  }
  $('#w-dis-diag').onclick = diagnose;
  $('#w-dis-ip').addEventListener('keydown', e => { if (e.key === 'Enter') diagnose(); });

  // ---- prueba ----
  $('#w-test').onclick = async () => {
    const box = $('#w-preview');
    box.innerHTML = '<div class="muted"><span class="spinner"></span> Probando conexión…</div>';
    try {
      const r = await api('/cameras/test', { method: 'POST', body: collectForm() });
      if (r.ok) {
        box.innerHTML = `<img src="${r.snapshot}" style="width:100%;border-radius:10px">
          <div class="muted" style="margin-top:6px">✓ Conexión correcta · ${esc(r.resolution || '')}</div>`;
      } else {
        box.innerHTML = `<div class="muted">✗ No se pudo conectar: ${esc(r.error || 'error desconocido')}</div>`;
      }
    } catch (e) { box.innerHTML = `<div class="muted">✗ ${esc(e.message)}</div>`; }
  };

  $('#w-save').onclick = async () => {
    const payload = collectForm();
    if (!payload.name) { toast('Ponle un nombre a la cámara', 'warn'); return; }
    try {
      await api('/cameras', { method: 'POST', body: payload });
      toast('Cámara añadida');
      closeModal();
      await refresh(true);
      location.hash = '#/dashboard';
    } catch (e) { toast(e.message, 'err'); }
  };

  function collectForm() {
    const t = $('#w-type').value;
    const payload = {
      name: $('#w-name').value.trim(),
      group: $('#w-group').value.trim() || 'General',
      source_type: t,
      url: t === 'rtsp' ? $('#w-url').value.trim()
        : t === 'file' ? $('#w-file').value.trim() : '',
      substream_url: t === 'rtsp' ? $('#w-sub').value.trim() : '',
      username: t === 'rtsp' ? $('#w-user').value : '',
      password: t === 'rtsp' ? $('#w-pass').value : '',
      device_index: t === 'usb' ? +$('#w-index').value : 0,
      device_name: t === 'usb' ? $('#w-devname').value.trim() : '',
    };
    if (!$('#w-onvif').checked) return payload;
    return {
      ...payload,
      onvif: {
        enabled: true,
        host: $('#w-ov-host').value.trim(),
        port: +$('#w-ov-port').value || 80,
        username: $('#w-ov-user').value,
        password: $('#w-ov-pass').value,
        profile_token: $('#w-ov-token').value.trim(),
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Ajustes de una cámara                                               */
/* ------------------------------------------------------------------ */
async function cameraSettings(id) {
  const cam = state.cameras.find(c => c.id === id);
  if (!cam) return;
  openModal(`Ajustes · ${cam.name}`, `
    <div class="form-grid">
      <div class="field"><label>Nombre</label><input id="c-name" value="${esc(cam.name)}"></div>
      <div class="field"><label>Grupo</label><input id="c-group" value="${esc(cam.group || '')}"></div>
      <div class="field"><label>Tipo</label>
        <select id="c-type" disabled>
          ${['rtsp', 'usb', 'file', 'demo'].map(t => `<option value="${t}" ${cam.source_type === t ? 'selected' : ''}>${t.toUpperCase()}</option>`).join('')}
        </select></div>
      <div class="field"><label>URL principal</label><input id="c-url" value="${esc(cam.url || '')}"></div>
      <div class="field"><label>URL secundaria</label><input id="c-sub" value="${esc(cam.substream_url || '')}"></div>
      <div class="field"><label>Usuario</label><input id="c-user" value="${esc(cam.username || '')}"></div>
      <div class="field"><label>Contraseña</label><input type="password" id="c-pass" value="${esc(cam.password || '')}"></div>
    </div>
    <div class="divider"></div>
    <h4>Alertas</h4>
    <label class="checkline"><input type="checkbox" id="c-alerts" ${cam.alerts?.enabled ? 'checked' : ''}> Enviar avisos de esta cámara</label>
    <label class="checkline"><input type="checkbox" id="c-away" ${cam.alerts?.only_when_away ? 'checked' : ''}> Sólo cuando esté fuera de casa</label>
    <div class="field"><label>Canales (vacío = todos los activos)</label>
      <input id="c-channels" value="${esc((cam.alerts?.channels || []).join(','))}" placeholder="telegram,ntfy"></div>
    <div class="divider"></div>
    <div class="row" style="justify-content:space-between">
      <button class="btn danger" id="c-delete">Eliminar cámara</button>
      <div class="row">
        <button class="btn ghost" id="c-cancel">Cancelar</button>
        <button class="btn primary" id="c-save">Guardar</button>
      </div>
    </div>`, { wide: false });

  $('#c-cancel').onclick = closeModal;
  $('#c-save').onclick = async () => {
    await api(`/cameras/${id}`, {
      method: 'PATCH',
      body: {
        name: $('#c-name').value,
        group: $('#c-group').value,
        url: $('#c-url').value,
        substream_url: $('#c-sub').value,
        username: $('#c-user').value,
        password: $('#c-pass').value,
        alerts: {
          enabled: $('#c-alerts').checked,
          only_when_away: $('#c-away').checked,
          channels: $('#c-channels').value.split(',').map(s => s.trim()).filter(Boolean),
        },
      },
    });
    toast('Cámara actualizada'); closeModal(); refresh(true);
  };
  $('#c-delete').onclick = () => confirmModal('Eliminar cámara',
    `Se eliminará "${cam.name}". Puedes borrar también sus grabaciones.`, async () => {
      await api(`/cameras/${id}?purge=true`, { method: 'DELETE' });
      toast('Cámara eliminada'); refresh(true);
    });
}

document.addEventListener('DOMContentLoaded', boot);
