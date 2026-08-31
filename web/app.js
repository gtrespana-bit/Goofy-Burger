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
  multiview: { layout: 'auto', order: JSON.parse(localStorage.getItem('vigia-multiview-order') || '[]') },
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
    if (e.target.hasAttribute('data-yes')) { closeModal(); onYes(); }
    if (e.target.hasAttribute('data-close') || e.target.id === 'modal-close') closeModal();
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
    await route();
    setInterval(() => refresh(false), 5000);
    setInterval(checkNewEvents, 6000);
  } catch (err) {
    console.error('Error durante el arranque:', err);
    // Asegurarse de que el modal esté oculto si hubo un error
    closeModal();
  }
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, param] = hash.split('/');
  state.view = view || 'dashboard';
  state.cameraId = view === 'camera' ? param : null;
  $$('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === (view || 'dashboard')));
  try {
    await render();
  } catch (err) {
    console.error('Error cargando vista', state.view, err);
    $('#view').innerHTML = `<div class="panel empty"><span class="big">⚠️</span><p>No se pudo cargar la vista: ${esc(err.message)}</p><button class="btn" id="retry-view">Reintentar</button></div>`;
    $('#retry-view').onclick = () => route();
  }
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
      await render();
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
    `${state.info.edition || 'Pro'} · ${state.info.local_ip || ''} · ${state.info.platform || ''} · ffmpeg ${state.info.ffmpeg ? '✓' : '✗'}`;

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
async function render() {
  const view = state.view;
  if (view === 'dashboard') return await renderDashboard();
  if (view === 'multiview') return await renderMultiview();
  if (view === 'camera') return await renderCamera();
  if (view === 'events') return await renderEvents();
  if (view === 'recordings') return await renderRecordings();
  if (view === 'settings') return await renderSettings();
  return await renderDashboard();
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

async function renderDashboard() {
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

  let dash = { cameras: state.cameras.length, online: 0, recording: 0, events_today: 0, by_label: {}, storage: {} };
  try {
    dash = await api('/system/dashboard');
    state.dash = dash;
  } catch { /* el panel no debe romperse si falla */ }

  const groups = {};
  state.cameras
    .slice().sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach(c => { (groups[c.group || 'General'] ||= []).push(c); });

  const kpis = `
  <div class="kpis">
    <div class="kpi"><span class="label">Cámaras</span><b>${dash.online ?? 0}/${dash.cameras ?? state.cameras.length}</b><span class="sub">en directo</span></div>
    <div class="kpi"><span class="label">Grabación</span><b>${dash.recording ?? 0}</b><span class="sub">ahora mismo</span></div>
    <div class="kpi"><span class="label">Hoy</span><b>${dash.events_today ?? 0}</b><span class="sub">eventos <span class="muted">${Object.entries(dash.by_label || {}).map(([k, v]) => `${k}:${v}`).join(' · ')}</span></span></div>
    <div class="kpi"><span class="label">Almacenamiento</span><b>${fmtBytes(((dash.storage?.recordings?.bytes || 0) + (dash.storage?.clips?.bytes || 0)))}</b><span class="sub">${fmtBytes(dash.storage?.disk?.free || 0)} libres</span></div>
  </div>`;

  view.innerHTML = kpis + Object.entries(groups).map(([group, cams]) => `
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
    const full = card.querySelector('[data-act="full"]');
    if (full) full.onclick = e => {
      e.stopPropagation();
      const img = card.querySelector('.feed img');
      const src = img ? img.src : `/api/stream/${card.dataset.cam}/live.mjpg`;
      openModal('Pantalla completa', `<div class="video-wrap"><img src="${esc(src)}" style="width:100%;height:70vh;object-fit:contain;background:#000"></div>
        <div class="row" style="justify-content:flex-end;margin-top:8px">
          <a class="btn" href="${esc(src)}" target="_blank">Abrir en pestaña</a>
          <button class="btn ghost" data-close>Cerrar</button>
        </div>`, { wide: true });
      const cb = $('[data-close]', $('#modal-body'));
      if (cb) cb.onclick = closeModal;
    };
    const restart = card.querySelector('[data-act="restart"]');
    if (restart) restart.onclick = async e => {
      e.stopPropagation();
      await api(`/cameras/${card.dataset.cam}/restart`, { method: 'POST' });
      toast('Cámara reiniciándose');
    };
  });
}

function camCard(cam) {
  const st = cam.health?.state || 'stopped';
  const rec = !!cam.health?.recording;
  const color = cam.color ? `border-top:3px solid ${esc(cam.color)}` : '';
  const location = cam.location ? `<span class="badge">📍 ${esc(cam.location)}</span>` : '';
  const tags = (cam.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  return `
  <div class="cam" data-cam="${cam.id}" style="${color}">
    <div class="feed" id="feed-${cam.id}">
      <img src="/api/stream/${cam.id}/live.mjpg" alt="${esc(cam.name)}" loading="lazy">
      <div class="overlay"></div>
      <div class="tag">
        <span class="badge state ${st}">${stateLabel(st)}</span>
        <span class="badge rec" style="display:${rec ? 'flex' : 'none'}">● REC</span>
      </div>
      <span class="motion">MOVIMIENTO</span>
      <button class="btn sm ghost fullbang" data-act="full" title="Pantalla completa">⛶</button>
    </div>
    <div class="caminfo">
      <div>
        <div class="name">${esc(cam.name)} ${location}</div>
        <div class="meta">${camMeta(cam)}</div>
        ${tags ? `<div class="row" style="margin-top:4px">${tags}</div>` : ''}
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
      <button class="btn sm" data-act="restart">Reiniciar</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Muro multi-vista                                                    */
/* ------------------------------------------------------------------ */
async function renderMultiview() {
  const view = $('#view');
  const mv = state.multiview;
  const cams = state.cameras.slice().sort((a,b) => (a.order||0)-(b.order||0));
  const ordered = mv.order.length ? mv.order.map(id => cams.find(c => c.id === id)).filter(Boolean) : cams;
  const rest = cams.filter(c => !ordered.includes(c));
  const list = ordered.concat(rest);
  if (!list.length) {
    view.innerHTML = `<div class="panel empty"><span class="big">🤖</span><p>No hay cámaras para mostrar en el muro.</p>
      <button class="btn primary" id="mw-add">+ Añadir cámara</button></div>`;
    const add = $('#mw-add');
    if (add) add.onclick = () => cameraWizard();
    return;
  }

  const layouts = [
    ['auto', 'Auto'], ['1x1', '1×1'], ['2x2', '2×2'], ['3x3', '3×3'], ['4x4', '4×4'],
  ];
  const cols = mv.layout === '1x1' ? 1 : mv.layout === '2x2' ? 2 : mv.layout === '3x3' ? 3 : mv.layout === '4x4' ? 4 :
    Math.min(4, Math.ceil(Math.sqrt(list.length)) || 1);
  const rows = Math.ceil(list.length / cols);

  view.innerHTML = `
  <div class="panel" style="padding:10px 12px;margin-bottom:12px">
    <div class="spread">
      <div class="row" id="mw-layout">
        ${layouts.map(([v, label]) => `<button class="btn sm ${mv.layout === v ? 'primary' : ''}" data-layout="${v}">${label}</button>`).join('')}
      </div>
      <div class="row">
        <span class="muted">${list.length} cámara(s)</span>
        <button class="btn sm" id="mw-full">⛶ Pantalla completa</button>
      </div>
    </div>
  </div>
  <div class="mw-grid" id="mw-grid" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">
    ${list.map((cam, i) => `
      <div class="mw-cell" data-cam="${cam.id}" data-idx="${i}">
        <div class="mw-feed"><img src="/api/stream/${cam.id}/live.mjpg" alt="${esc(cam.name)}" loading="lazy"></div>
        <div class="mw-top">
          <span class="badge state ${cam.health?.state || 'stopped'}">${stateLabel(cam.health?.state || 'stopped')}</span>
          ${cam.health?.recording ? '<span class="badge rec">● REC</span>' : ''}
        </div>
        <div class="mw-name">${esc(cam.name)}</div>
        <div class="mw-actions">
          <button class="btn sm ghost" data-act="open" title="Abrir">⤢</button>
          <button class="btn sm ghost" data-act="snap" title="Instantánea">📷</button>
        </div>
      </div>`).join('')}
  </div>`;

  $$('#mw-layout [data-layout]').forEach(b => b.onclick = () => {
    mv.layout = b.dataset.layout;
    renderMultiview();
  });
  const fullBtn = $('#mw-full');
  if (fullBtn) fullBtn.onclick = () => {
    openModal('Muro · Pantalla completa', `<div id="mw-modal" class="mw-grid" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);grid-auto-rows:1fr;height:78vh">
      ${list.map(cam => `<div class="mw-cell"><div class="mw-feed"><img src="/api/stream/${cam.id}/live.mjpg" alt="${esc(cam.name)}"></div><div class="mw-name">${esc(cam.name)}</div></div>`).join('')}
    </div>`, { wide: true });
  };
  $$('[data-cam]', '#mw-grid').forEach(cell => {
    const id = cell.dataset.cam;
    cell.querySelector('[data-act="open"]').onclick = () => { location.hash = '#/camera/' + id; };
    cell.querySelector('[data-act="snap"]').onclick = () => {
      openModal('Instantánea', `<img src="/api/stream/${id}/snapshot.jpg?force=true&t=${Date.now()}" style="width:100%;border-radius:10px">`, { wide: true });
    };
  });
}

/* ------------------------------------------------------------------ */
/* Vista de cámara                                                     */
/* ------------------------------------------------------------------ */
async function renderCamera() {
  const id = state.cameraId;
  const cam = state.cameras.find(c => c.id === id);
  if (!cam) { location.hash = '#/dashboard'; return; }
  const events = await api(`/events?camera_id=${id}&limit=12`);

  const recMode = cam.recording?.mode || 'continuous';
  const quality = { high: 'Alta', medium: 'Media', low: 'Baja', custom: 'Personalizada' }[cam.recording?.quality || 'medium'] || 'Media';
  const tags = (cam.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
  $('#view').innerHTML = `
  <div class="spread" style="margin-bottom:12px">
    <div>
      <h2 style="font-size:19px">${esc(cam.name)} ${cam.location ? `<span class="badge">📍 ${esc(cam.location)}</span>` : ''}</h2>
      <div class="muted">${esc(cam.group || 'General')} · ${stateLabel(cam.health?.state || 'stopped')}
        · ${esc(cam.health?.resolution || '')} · grabación ${recMode} · ${quality}</div>
      ${tags ? `<div class="row" style="margin-top:4px">${tags}</div>` : ''}
    </div>
    <div class="row">
      <button class="btn ghost" id="cam-back">← Volver</button>
      <button class="btn" id="cam-snap">Instantánea</button>
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
              <option value="continuous" ${recMode === 'continuous' ? 'selected' : ''}>Continua (24/7 por segmentos)</option>
              <option value="motion" ${recMode === 'motion' ? 'selected' : ''}>Sólo cuando hay movimiento</option>
              <option value="smart" ${recMode === 'smart' ? 'selected' : ''}>Inteligente (continua + clips)</option>
              <option value="scheduled" ${recMode === 'scheduled' ? 'selected' : ''}>Por horario</option>
              <option value="off" ${recMode === 'off' ? 'selected' : ''}>No grabar</option>
            </select>
          </div>
          <div class="field">
            <label>Espera entre eventos (s)</label>
            <input type="number" id="cooldown" min="0" max="600" value="${cam.detection?.cooldown_seconds ?? 20}">
          </div>
          <div class="field">
            <label>Zonas / privacidad</label>
            <button class="btn sm" id="btn-zones" style="width:100%">🗺️ Zonas de detección</button>
            <button class="btn sm ghost" id="btn-privacy" style="width:100%;margin-top:4px">🔒 Máscara de privacidad</button>
          </div>
          <div class="field">
            <label>Acciones</label>
            <div class="row">
              <button class="btn sm" id="btn-save-det">Guardar cambios</button>
              <button class="btn sm ghost" id="btn-restart">Reiniciar</button>
            </div>
          </div>
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
  $('#cam-snap').onclick = () => {
    openModal('Instantánea', `<img src="/api/stream/${id}/snapshot.jpg?force=true&t=${Date.now()}"
      style="width:100%;border-radius:10px">`, { wide: true });
  };
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
  const privacyBtn = $('#btn-privacy');
  if (privacyBtn) privacyBtn.onclick = () => privacyEditor(cam);
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

/*
 * Editor de máscaras de privacidad: igual que las zonas pero guarda en
 * detection.privacy_mask y el backend las ignora siempre al detectar.
 */
function privacyEditor(cam) {
  const field = 'privacy_mask';
  const zones = JSON.parse(JSON.stringify(cam.detection?.[field] || []));
  openModal('Máscaras de privacidad', `
    <p class="muted">Dibuja zonas que siempre se ignorarán en la detección
    (ventanas, puertas, televisores...). No afectan al vídeo, sólo al análisis.</p>
    <div class="zone-editor"><canvas id="zone-canvas"></canvas></div>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="zone-close">Cerrar zona</button>
      <button class="btn ghost" id="zone-undo">Quitar último punto</button>
      <button class="btn danger" id="zone-clear">Borrar todo</button>
      <span class="muted" id="zone-count"></span>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" id="zone-cancel">Cancelar</button>
      <button class="btn primary" id="zone-save">Guardar</button>
    </div>`, { wide: true });

  const canvas = $('#zone-canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  let current = [];
  img.onload = () => { canvas.width = img.width; canvas.height = img.height; draw(); };
  img.src = `/api/stream/${cam.id}/snapshot.jpg?force=true&t=${Date.now()}`;
  img.onerror = () => toast('No se pudo cargar la imagen de la cámara', 'err');

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const poly = pts => pts.map(p => [p[0] * canvas.width, p[1] * canvas.height]);
    zones.forEach(z => {
      const p = poly(z);
      if (p.length < 2) return;
      ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      p.slice(1).forEach(pt => ctx.lineTo(pt[0], pt[1]));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,80,80,.14)';
      ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    });
    if (current.length) {
      const p = poly(current);
      ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      p.slice(1).forEach(pt => ctx.lineTo(pt[0], pt[1]));
      ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 2; ctx.stroke();
      p.forEach(pt => { ctx.beginPath(); ctx.arc(pt[0], pt[1], 4, 0, 7); ctx.fillStyle = '#ffb454'; ctx.fill(); });
    }
    $('#zone-count').textContent = `${zones.length} máscara(s), ${current.length} punto(s) en curso`;
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
    await api(`/cameras/${cam.id}`, { method: 'PATCH', body: { detection: { [field]: zones } } });
    toast('Máscaras de privacidad guardadas');
    closeModal(); refresh(true);
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
    await render();
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
    toast('Grabación borrada'); closeModal(); await render();
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
  if (!f.recMode) f.recMode = 'timeline';
  const qs = new URLSearchParams({ limit: 400 });
  if (f.recCamera) qs.set('camera_id', f.recCamera);
  if (f.recDate) qs.set('date', f.recDate);
  if (f.recKind) qs.set('kind', f.recKind);
  const data = await api('/recordings?' + qs);
  state.recordings = data.items || [];
  const cal = await api('/recordings/calendar?days=31' + (f.recCamera ? `&camera_id=${f.recCamera}` : ''));
  const st = data.storage;
  const day = f.recDate || todayStr();

  $('#view').innerHTML = `
  <div class="panel">
    <div class="spread">
      <div class="row">
        <select id="rec-cam"><option value="">Todas las cámaras</option>
          ${state.cameras.map(c => `<option value="${c.id}" ${f.recCamera === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <input type="date" id="rec-date" value="${day}" style="width:auto">
        ${f.recMode === 'list' ? `<select id="rec-kind" style="width:auto">
          <option value="">Todo</option>
          <option value="segment" ${f.recKind === 'segment' ? 'selected' : ''}>Grabación continua</option>
          <option value="clip" ${f.recKind === 'clip' ? 'selected' : ''}>Clips por movimiento</option>
        </select>` : ''}
        <div class="row" style="gap:4px">
          <button class="btn sm ${f.recMode === 'timeline' ? 'primary' : ''}" id="rec-mode-tl">📅 Timeline</button>
          <button class="btn sm ${f.recMode === 'list' ? 'primary' : ''}" id="rec-mode-list">📃 Lista</button>
        </div>
        ${f.recCamera || f.recKind ? '<button class="btn sm ghost" id="rec-reset">Quitar filtros</button>' : ''}
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

  <div id="rec-content" style="margin-top:14px"></div>`;

  $('#rec-mode-tl').onclick = () => { f.recMode = 'timeline'; renderRecordings(); };
  $('#rec-mode-list').onclick = () => { f.recMode = 'list'; renderRecordings(); };
  $('#rec-cam').onchange = e => { f.recCamera = e.target.value; renderRecordings(); };
  $('#rec-date').onchange = e => { f.recDate = e.target.value; renderRecordings(); };
  const kind = $('#rec-kind');
  if (kind) kind.onchange = e => { f.recKind = e.target.value; renderRecordings(); };
  const reset = $('#rec-reset');
  if (reset) reset.onclick = () => { f.recCamera = ''; f.recDate = ''; f.recKind = ''; renderRecordings(); };
  $$('[data-date]').forEach(b => b.onclick = () => {
    f.recDate = f.recDate === b.dataset.date ? '' : b.dataset.date;
    renderRecordings();
  });
  $('#rec-prune').onclick = () => confirmModal('Limpiar grabaciones antiguas',
    'Se borrarán las grabaciones más viejas que el período de retención configurado.', async () => {
      const r = await api('/recordings/prune', { method: 'POST', body: {} });
      toast(`Liberados ${fmtBytes(r.bytes)} (${r.files} ficheros)`);
      renderRecordings();
    });

  const content = $('#rec-content');
  if (f.recMode === 'timeline') {
    const tl = await api(`/recordings/timeline?date=${encodeURIComponent(day)}${f.recCamera ? `&camera_id=${f.recCamera}` : ''}`);
    content.innerHTML = timelinePanel(tl, day);
    wireTimeline();
  } else {
    content.innerHTML = `<div class="list">
      ${state.recordings.length ? state.recordings.map(recItem).join('')
        : '<div class="empty"><span class="big">📼</span>No hay grabaciones para este filtro</div>'}</div>`;
    $$('[data-rec]').forEach(el => el.onclick = () => videoModal(el.dataset.rec, el.dataset.name));
  }
}

function timelinePanel(tl, day) {
  const items = tl.items || [];
  const events = tl.events || [];
  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(h);
  const itemBars = items.map((r, i) => {
    const x0 = ((r.start_ts - new Date(day + 'T00:00:00').getTime()) / 3600000) / 24 * 100;
    const x1 = Math.max(x0 + 0.4, ((r.end_ts - new Date(day + 'T00:00:00').getTime()) / 3600000) / 24 * 100);
    return `<div class="tl-item ${r.kind === 'clip' ? 'clip' : 'seg'}" data-rec="${esc(r.path)}" data-name="${esc(r.name)}" title="${esc(r.camera_name)} · ${fmtTime(r.start)} · ${fmtDur(r.duration)} · ${fmtBytes(r.size)}" style="left:${x0}%;width:${Math.min(100 - x0, x1 - x0)}%">
      ${r.kind === 'clip' ? '◆' : ''} ${esc(r.camera_name)} ${fmtDur(r.duration)}</div>`;
  }).join('');
  const eventDots = events.map(ev => {
    const ts = new Date((ev.ts || '').replace(' ', 'T'));
    const pct = ((ts - new Date(day + 'T00:00:00').getTime()) / 3600000) / 24 * 100;
    return `<button class="tl-event" data-event="${ev.id}" title="${esc(ev.camera_name)} · ${esc(ev.label)} · ${fmtTime(ev.ts)}" style="left:${pct}%">${esc(ev.label || 'e')}</button>`;
  }).join('');
  const empty = !items.length && !events.length;
  return `
  <div class="panel">
    <div class="spread">
      <h3>📅 Timeline ${esc(day)}</h3>
      <div class="row"><span class="muted">${items.length} grabaciones · ${events.length} eventos</span></div>
    </div>
    <div class="tl">
      <div class="tl-ticks">${hours.map(h => `<span style="left:${h/24*100}%">${String(h).padStart(2,'0')}</span>`).join('')}</div>
      <div class="tl-track">${empty ? '<div class="muted" style="padding:30px;text-align:center">Sin actividad este día.</div>' : itemBars + eventDots}</div>
      <div class="tl-legend">
        <span><i class="lg seg"></i> Continua</span>
        <span><i class="lg clip"></i> Clip movimiento</span>
        <span><i class="lg ev"></i> Evento</span>
      </div>
    </div>
  </div>`;
}

function wireTimeline() {
  $$('.tl-item').forEach(el => el.onclick = () => videoModal(el.dataset.rec, el.dataset.name));
  $$('.tl-event').forEach(el => el.onclick = () => eventModal(el.dataset.event));
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
      <h4>Discord</h4>
      <label class="checkline"><input type="checkbox" id="di-on" ${s.notifications?.discord?.enabled ? 'checked' : ''}> Activar</label>
      <div class="field"><label>Webhook URL</label><input id="di-url" value="${esc(s.notifications?.discord?.webhook_url || '')}" placeholder="https://discord.com/api/webhooks/.../"></div>

      <div class="divider"></div>
      <h4>Pushover</h4>
      <label class="checkline"><input type="checkbox" id="po-on" ${s.notifications?.pushover?.enabled ? 'checked' : ''}> Activar</label>
      <div class="field"><label>App token</label><input id="po-token" value="${esc(s.notifications?.pushover?.app_token || '')}"></div>
      <div class="field"><label>User key</label><input id="po-user" value="${esc(s.notifications?.pushover?.user_key || '')}"></div>

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
        <div class="field"><label>Máx eventos/min (0=sín límite)</label>
          <input type="number" min="0" id="dt-maxmin" value="${s.detection?.max_events_per_minute ?? 0}"></div>
        <div class="field grid-span2">${scheduleField('dt-schedule', s.detection?.schedule, 'Detección por defecto: vacío = siempre activa.')}</div>
        <label class="checkline"><input type="checkbox" id="dt-light" ${s.detection?.ignore_light_change !== false ? 'checked' : ''}> Ignorar cambios globales de luz</label>
        <label class="checkline"><input type="checkbox" id="dt-tamper" ${s.detection?.tamper_enabled ? 'checked' : ''}> Detectar cámara tapada (por defecto)</label>
        <div class="field"><label>Modo de grabación</label>
          <select id="rd-mode">
            <option value="continuous" ${s.recording?.mode === 'continuous' ? 'selected' : ''}>Continua</option>
            <option value="motion" ${s.recording?.mode === 'motion' ? 'selected' : ''}>Sólo movimiento</option>
            <option value="smart" ${s.recording?.mode === 'smart' ? 'selected' : ''}>Inteligente</option>
            <option value="scheduled" ${s.recording?.mode === 'scheduled' ? 'selected' : ''}>Por horario</option>
            <option value="off" ${s.recording?.mode === 'off' ? 'selected' : ''}>Desactivada</option>
          </select></div>
        <div class="field"><label>Calidad grabación</label>
          <select id="rd-quality">${['high','medium','low','custom'].map(q => `<option value="${q}" ${s.recording?.quality === q ? 'selected' : ''}>${q}</option>`).join('')}</select></div>
        <div class="field"><label>CRF</label><input type="number" min="0" max="51" id="rd-crf" value="${s.recording?.crf ?? 23}"></div>
        <div class="field"><label>Preset</label>
          <select id="rd-preset">${['ultrafast','superfast','veryfast','faster','fast','medium'].map(p => `<option value="${p}" ${s.recording?.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="field"><label>Bitrate (vacío=CRF)</label><input id="rd-bitrate" value="${esc(s.recording?.bitrate || '')}" placeholder="2500k"></div>
        <div class="field"><label>Resolución (0=original)</label><div class="row"><input type="number" min="0" id="rd-w" value="${s.recording?.width || 0}"><input type="number" min="0" id="rd-h" value="${s.recording?.height || 0}"></div></div>
        <div class="field"><label>FPS destino</label><input type="number" min="0" max="60" id="rd-fps" value="${s.recording?.fps || 0}"></div>
        <div class="field"><label>Segmento (s)</label>
          <input type="number" min="10" id="rd-seg" value="${s.recording?.segment_seconds ?? 300}"></div>
        <div class="field"><label>Pre / post grabación (s)</label>
          <div class="row">
            <input type="number" min="0" id="rd-pre" value="${s.recording?.pre_seconds ?? 5}">
            <input type="number" min="1" id="rd-post" value="${s.recording?.post_seconds ?? 10}">
          </div></div>
        <div class="field"><label>Máx duración evento (s)</label><input type="number" min="30" id="rd-max" value="${s.recording?.max_event_seconds ?? 600}"></div>
        <div class="field grid-span2">${scheduleField('rd-schedule', s.recording?.schedule, 'Grabación por defecto: vacío = siempre activa (modo por horario).')}</div>
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
      <div class="field"><label>Nombre del sistema</label><input id="gn-name" value="${esc(s.general?.system_name || 'Vigía Pro')}"></div>
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
        <tr><td>Edición</td><td><b>${esc(info.edition || 'Pro')}</b></td></tr>
      </table>
      <details class="pro-features"><summary>✨ Funciones premium incluidas (${(info.features || []).length})</summary>
        <ul>${(info.features || []).map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      </details>
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
        discord: { enabled: $('#di-on').checked, webhook_url: $('#di-url').value },
        pushover: { enabled: $('#po-on').checked, app_token: $('#po-token').value, user_key: $('#po-user').value },
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
        max_events_per_minute: +$('#dt-maxmin').value,
        ignore_light_change: $('#dt-light').checked,
        tamper_enabled: $('#dt-tamper').checked,
        schedule: parseScheduleText($('#dt-schedule').value),
        ai_enabled: $('#dt-ai').checked, ai_model: $('#dt-model').value,
        ai_confidence: +$('#dt-conf').value,
        ai_labels: $('#dt-labels').value.split(',').map(s => s.trim()).filter(Boolean),
      },
    });
    await api('/settings/recording', {
      method: 'PATCH',
      body: {
        mode: $('#rd-mode').value,
        quality: $('#rd-quality').value,
        crf: +$('#rd-crf').value,
        preset: $('#rd-preset').value,
        bitrate: $('#rd-bitrate').value,
        width: +$('#rd-w').value,
        height: +$('#rd-h').value,
        fps: +$('#rd-fps').value,
        segment_seconds: +$('#rd-seg').value,
        pre_seconds: +$('#rd-pre').value,
        post_seconds: +$('#rd-post').value,
        max_event_seconds: +$('#rd-max').value,
        schedule: parseScheduleText($('#rd-schedule').value),
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
/* Helpers de URLs RTSP / iCSee-XMEye                                 */
/* ------------------------------------------------------------------ */
// Detecta si una URL es de una cámara iCSee/XMEye (credenciales en la ruta).
function isIcseeUrl(u) {
  return /user=[^&/?\s]*&(?:password|passwd)=/i.test(u) ||
         /user=[^_?\s]*(?:_password|_passwd)=/i.test(u) ||
         /(?:^|[?&_])user=.*(?:^|[?&_])(?:password|passwd)=/i.test(u);
}

// Extrae host y credenciales de una URL iCSee/XMEye (user=..&password=..,
// user=.._password=.., user=.._passwd=..).
function icseeInfo(u) {
  let host = '';
  try { host = new URL(u).hostname; } catch {}
  const um = /(?:^|[?&_/])user=([^&_?\s]*)/i.exec(u);
  const pm = /(?:^|[?&_])?(?:password|passwd)=([^&_?\s]*)/i.exec(u);
  return { host, username: um ? decodeURIComponent(um[1]) : '', password: pm ? decodeURIComponent(pm[1]) : '' };
}

// Rellena usuario/contraseña en una URL RTSP.
// En iCSee/XMEye se escriben dentro del path; en el resto, en el usuario de la URL.
function fillUrlCredentials(u, username, password) {
  if (!u) return u;
  const user = username || '', pass = password || '';
  if (isIcseeUrl(u)) {
    let out = u.replace(/(user=)([^&_?\s]*)/i, `$1${encodeURIComponent(user)}`);
    out = out.replace(/([?&_])?(?:password|passwd)=[^&_?\s]*/i, `$1${pass ? 'password=' + encodeURIComponent(pass) : 'password='}`);
    return out;
  }
  // URL estándar: si ya trae usuario, no la tocamos.
  if (/([a-z]+):\/\/[^/@]+@/i.test(u)) return u;
  try {
    const parsed = new URL(u);
    parsed.username = user;
    parsed.password = pass;
    return parsed.toString();
  } catch {
    return u;
  }
}

function scheduleToText(schedule) {
  const names = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  return (schedule || []).map((e, i) => `${(e.days || []).map(d => names[d]).join('') || 'Todos'} ${e.start || '00:00'}-${e.end || '23:59'}`).join(' · ');
}

function parseScheduleText(text) {
  const out = [];
  const parts = (text || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^([A-Za-z0-9, -]+)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) continue;
    const names = {L:0, M:1, X:2, J:3, V:4, S:5, D:6};
    const ws = m[1].toUpperCase().replace(/\s+/g, '');
    const days = [];
    if (!ws || ws === 'TODOS') {
      days.push(0,1,2,3,4,5,6);
    } else if (/[0-9]/.test(ws)) {
      for (const part of ws.split(',')) {
        if (/^\d-\d$/.test(part)) {
          const [a, b] = part.split('-').map(Number);
          for (let d = Math.min(a, b); d <= Math.max(a, b); d++) if (d >= 0 && d <= 6) days.push(d);
        } else if (/^\d$/.test(part)) days.push(+part);
      }
    } else {
      for (const ch of ws) if (ch in names) days.push(names[ch]);
    }
    if (days.length) out.push({ days: [...new Set(days)].sort(), start: m[2], end: m[3] });
  }
  return out;
}

// Renderiza un textarea simple pero legible para horarios.
function scheduleField(id, schedule, hint) {
  return `<div class="field"><label>Horario <span class="muted">(vacío = siempre)</span></label>
    <input id="${id}" value="${esc(scheduleToText(schedule))}" placeholder="L-V 08:00-20:00 · S-D 00:00-23:59">
    <span class="hint">${hint || 'Formato: <code>L-V 08:00-20:00</code>. Separados por punto y coma.'}</span></div>`;
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

  function onvifConfigFor(url, port = 8899, username = '', password = '') {
    const info = icseeInfo(url);
    const user = username || info.username;
    const pass = password !== undefined ? password : info.password;
    return {
      enabled: true,
      host: info.host,
      port: +(port || 8899),   // iCSee/XMEye suele usar 8899, pero probamos 80/8080/8000
      username: user,
      password: pass,
      profile_token: '',
    };
  }

  // Crea una cámara por cada canal/lente detectado. Las URLs ya traen las
  // credenciales embebidas (user=..&password=..), así que no las pisamos.
  // Para cámaras iCSee/XMEye activa ONVIF en el puerto detectado para
  // mover/zoom (PTZ); si sólo una lente es giratoria, ese canal recibe el
  // token del perfil PTZ.
  async function addAllChannels(groups, onvifInfo = null) {
    const base = $('#w-name').value.trim() || 'Cámara';
    const grp = $('#w-group').value.trim() || 'General';
    const icsee = groups.some(g => isIcseeUrl(g.main || g.sub));
    let added = 0;
    for (const g of groups) {
      const rawUrl = g.main || g.sub || '';
      // IMPORTANTE: las credenciales de RTSP pueden estar dentro de la propia
      // URL y/o en el formulario. Para que quede bien guardado y visible,
      // derivamos la cuenta de la URL (o de ONVIF si lo hay) y nunca dejamos
      // el alta "sin usuario y contraseña".
      const urlInfo = icseeInfo(rawUrl);
      const rtspUser = urlInfo.username || (onvifInfo && onvifInfo.username) || '';
      const rtspPass = urlInfo.password || (onvifInfo && onvifInfo.password) || '';
      const url = fillUrlCredentials(rawUrl, rtspUser, rtspPass);
      const payload = {
        name: g.mosaic ? `${base} · mosaico` : `${base} · lente ${g.channel}`,
        group: grp,
        source_type: 'rtsp',
        url,
        substream_url: g.sub ? fillUrlCredentials(g.sub, rtspUser, rtspPass) : '',
        username: rtspUser,
        password: rtspPass,
      };
      if (onvifInfo && onvifInfo.onvif_port) {
        // Si conocemos el puerto ONVIF, sólo activamos PTZ en la lente que
        // realmente lo soporta (si el backend nos lo indicó). Para la lente
        // giratoria usamos su token; para las fijas lo dejamos vacío.
        const knowPtz = typeof onvifInfo.has_ptz === 'boolean';
        const enablePtz = knowPtz ? !!g.has_ptz : true;
        payload.onvif = {
          enabled: enablePtz,
          host: onvifInfo.host || urlInfo.host || '',
          port: +onvifInfo.onvif_port || 8899,
          username: onvifInfo.username || rtspUser,
          password: onvifInfo.password || rtspPass,
          profile_token: (g.has_ptz ? (g.profile_token || onvifInfo.ptz_profile_token) : ''),
          use_onvif_stream: false,
        };
      } else if (icsee) {
        payload.onvif = onvifConfigFor(url);
      }
      try {
        await api('/cameras', { method: 'POST', body: payload });
        added++;
      } catch (e) { toast(`${g.mosaic ? 'Mosaico' : 'Lente ' + g.channel}: ${e.message}`, 'err'); }
    }
    if (added) {
      toast(`${added} cámaras añadidas${icsee ? ' (ONVIF/PTZ configurado)' : ''}`);
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
            <button class="btn sm" data-diag="${esc(d.ip)}">Lentes iCSee</button>
          </div>`).join('') || '<div class="muted">No se han encontrado dispositivos.</div>';
      }
      $$('[data-url]', box).forEach(b => b.onclick = () => {
        $('#w-url').value = b.dataset.url;
        if (b.dataset.sub) $('#w-sub').value = b.dataset.sub;
        // Si es iCSee/XMEye, precarga usuario/password y ONVIF para mover/zoom.
        if (isIcseeUrl(b.dataset.url)) {
          const info = icseeInfo(b.dataset.url);
          $('#w-user').value = info.username;
          $('#w-pass').value = info.password;
          $('#w-onvif').checked = true;
          $('#w-onvif-box').style.display = '';
          $('#w-ov-host').value = info.host;
          $('#w-ov-port').value = 8899;
          $('#w-ov-user').value = info.username;
          $('#w-ov-pass').value = info.password;
          toast('URL, usuario y ONVIF (8899) puestos en el formulario');
        } else {
          toast('URL puesta en el formulario');
        }
      });
      $$('[data-probe]', box).forEach(b => b.onclick = () => discover('rtsp', b.dataset.probe));
      $$('[data-diag]', box).forEach(b => b.onclick = () => {
        $('#w-dis-ip').value = b.dataset.diag;
        diagnose();
      });
    } catch (e) {
      box.innerHTML = `<div class="muted">Error: ${esc(e.message)}</div>`;
    }
  }
  $('#w-dis-onvif').onclick = () => discover('onvif');
  $('#w-dis-scan').onclick = () => discover('scan');

  // Añade una cámara por cada perfil ONVIF (cada lente de una multi-lente).
  async function addAllOnvif(host, user, pass, profiles, port = 8899) {
    const base = $('#w-name').value.trim() || 'Cámara';
    const grp = $('#w-group').value.trim() || 'General';
    let added = 0;
    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      if (!p.rtsp) continue;
      // Las URLs que devuelve GetStreamUri suelen venir SIN usuario/contraseña.
      // Para iCSee/XMEye hay que rellenarlo para que OpenCV/ffmpeg abra el flujo.
      const url = fillUrlCredentials(p.rtsp, user, pass);
      const payload = {
        name: profiles.length > 1 ? `${base} · ${p.name || ('lente ' + (i + 1))}` : (base || 'Cámara'),
        group: grp,
        source_type: 'rtsp',
        url,
        substream_url: '',
        username: user || '',
        password: pass || '',
        onvif: {
          enabled: !!p.has_ptz,
          host,
          port: +(port || 8899),
          username: user || '',
          password: pass || '',
          profile_token: p.has_ptz ? (p.token || '') : '',
          use_onvif_stream: false,
        },
      };
      try {
        await api('/cameras', { method: 'POST', body: payload });
        added++;
      } catch (e) { toast(`${p.name || ('lente ' + (i + 1))}: ${e.message}`, 'err'); }
    }
    if (added) {
      toast(`${added} cámara(s) añadidas vía ONVIF`);
      closeModal();
      await refresh(true);
      location.hash = '#/dashboard';
    }
  }

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

      // Canales RTSP agrupados: para las iCSee/XMEye multi-lente es la forma
      // más clara de ver "Lente 1, Lente 2, Lente 3" y añadirlas de una vez.
      const channels = r.channels && r.channels.groups ? r.channels : null;
      const groups = channels ? channels.groups : [];
      const lensGroups = groups.filter(g => !g.mosaic);
      const mosaic = groups.find(g => g.mosaic);
      if (lensGroups.length || mosaic) {
        const hasPtz = lensGroups.some(g => g.has_ptz) || (channels && channels.has_ptz);
        const port = (channels && channels.onvif_port) || (r.onvif_profiles && r.onvif_profiles.port) || null;
        const addLabel = lensGroups.length > 0 ? `➕ Añadir los ${lensGroups.length}` : '➕ Añadir vista combinada';
        const titleAdd = lensGroups.length > 0
          ? `📷 Cámara iCSee 3 en 1 / multi-lente: ${lensGroups.length} canal(es)`
          : '🧩 Cámara iCSee 3 en 1: vista combinada (canal 0)';
        const metaAdd = lensGroups.length > 0
          ? `Cada lente se añadirá como cámara independiente.${hasPtz ? ' · una lente con PTZ.' : ''}`
          : 'Este modelo sólo expone la vista combinada por RTSP; se añade como una cámara.';
        html += `<div class="item" style="border-left:3px solid var(--accent,#3ddc97)">
          <div class="grow">
            <div class="title">${titleAdd}</div>
            <div class="meta">${port ? `ONVIF puerto ${port} · ` : ''}${metaAdd}</div>
          </div>
          <button class="btn sm primary" id="w-add-channels">${addLabel}</button>
        </div>`;
        html += lensGroups.map(g => `
          <div class="item"><div class="grow">
            <div class="title" style="font-size:12px">Lente ${esc(g.channel)}${g.has_ptz ? ' <span style="color:var(--accent,#3ddc97)">· PTZ</span>' : ''}</div>
            <div class="meta" style="font-size:11px;word-break:break-all">${esc(g.main || g.sub)}</div>
          </div>
          <button class="btn sm" data-url="${esc(g.main || g.sub || '')}" data-sub="${esc(g.sub || '')}">Usar</button></div>`).join('');
        if (mosaic && lensGroups.length) {
          html += `<div class="item" style="border-left:3px solid var(--accent,#3ddc97)">
            <div class="grow"><div class="title" style="font-size:12px">🧩 Mosaico (canal 0)</div>
            <div class="meta" style="font-size:11px;word-break:break-all">${esc(mosaic.main || mosaic.sub)}</div></div>
            <button class="btn sm" data-url="${esc(mosaic.main || '')}" data-sub="${esc(mosaic.sub || '')}">Usar</button></div>`;
        }
      } else {
        // Sin canales agrupados: si ONVIF reporta perfiles, usamos esos perfiles.
        const ov = r.onvif_profiles && r.onvif_profiles.profiles ? r.onvif_profiles : null;
        if (ov && ov.profiles.length) {
          const user = ov.username || '';
          const pass = ov.password ? $('#w-dis-pass').value : '';
          html += `<div class="item" style="border-left:3px solid var(--accent,#3ddc97)">
            <div class="grow">
              <div class="title">📷 Cámara multi-lente: ${ov.profiles.length} perfil(es) vía ONVIF (puerto ${ov.port || 8899})</div>
              <div class="meta">Cada perfil = un lente, se añadirá como cámara independiente.${ov.profiles.some(p => p.has_ptz) ? ' · con PTZ.' : ''}</div>
            </div>
            <button class="btn sm primary" id="w-add-onvif">➕ Añadir los ${ov.profiles.length}</button>
          </div>`;
          html += ov.profiles.map((p, i) => `
            <div class="item"><div class="grow">
              <div class="title" style="font-size:12px">${esc(p.name || ('Perfil ' + (i + 1)))}${p.has_ptz ? ' <span style="color:var(--accent,#3ddc97)">· PTZ</span>' : ''}</div>
              <div class="meta" style="font-size:11px;word-break:break-all">${p.width && p.height ? esc(p.width + 'x' + p.height) + ' · ' : ''}${esc(p.rtsp || 'sin stream')}</div>
            </div>
            <button class="btn sm" data-onvif-use="${i}">Usar</button></div>`).join('');
        }
      }

      const urls = (r.rtsp || []);
      if (urls.length && !groups.length) {
        html += `<div class="item"><div class="grow"><div class="title">✅ RTSP disponible (${urls.length})</div>` +
          urls.map(u => `<div class="meta" style="word-break:break-all"><button class="btn sm" data-url="${esc(u)}">Usar · ${esc(u)}</button></div>`).join('') +
          '</div></div>';
      } else if (!urls.length) {
        html += '<div class="item"><div class="grow"><div class="title" style="color:#ff6b6b">❌ RTSP sin respuesta</div></div></div>';
      }
      (r.hints || []).forEach(h => { html += `<div class="item"><div class="grow"><div class="meta">💡 ${esc(h)}</div></div></div>`; });
      box.innerHTML = html;

      const onvifPass = () => (channels && channels.password_present) || (r.onvif_profiles && r.onvif_profiles.password) ? $('#w-dis-pass').value : '';
      const channelInfo = channels ? Object.assign({}, channels, {
        host: ip,
        password: onvifPass(),
      }) : null;
      const addCh = $('#w-add-channels', box);
      if (addCh) addCh.onclick = () => addAllChannels(groups, channelInfo);

      // Botón "Añadir las N" (todos los perfiles/lentes de una vez) si no había canales.
      const addAll = $('#w-add-onvif', box);
      if (addAll) {
        const ov = r.onvif_profiles;
        addAll.onclick = () => addAllOnvif(ip, ov.username || '', ov.password ? $('#w-dis-pass').value : '', ov.profiles, ov.port || 8899);
      }
      $$('[data-onvif-use]', box).forEach(b => {
        const ov = r.onvif_profiles;
        b.onclick = () => {
          const p = ov.profiles[+b.dataset.onvifUse];
          $('#w-url').value = p.rtsp || '';
          $('#w-sub').value = '';
          $('#w-name').value = ($('#w-name').value.trim() || 'Cámara') + (ov.profiles.length > 1 ? ` · ${p.name || ''}` : '').trim();
          $('#w-onvif').checked = true;
          $('#w-onvif-box').style.display = '';
          $('#w-ov-host').value = ip;
          $('#w-ov-port').value = ov.port || 8899;
          $('#w-ov-user').value = ov.username || '';
          $('#w-ov-pass').value = ov.password ? $('#w-dis-pass').value : '';
          $('#w-ov-token').value = p.token || '';
          toast('URL del perfil puesta en el formulario');
        };
      });

      $$('[data-url]', box).forEach(b => b.onclick = () => {
        const url = b.dataset.url;
        $('#w-url').value = url;
        if (b.dataset.sub) $('#w-sub').value = b.dataset.sub;
        if (isIcseeUrl(url)) {
          const info = icseeInfo(url);
          const ov = r.onvif_profiles;
          const port = (channelInfo && channelInfo.onvif_port) || (ov && ov.port) || 8899;
          $('#w-user').value = info.username;
          $('#w-pass').value = info.password;
          $('#w-onvif').checked = true;
          $('#w-onvif-box').style.display = '';
          $('#w-ov-host').value = info.host;
          $('#w-ov-port').value = port;
          $('#w-ov-user').value = (channelInfo && channelInfo.username) || (ov && ov.username) || info.username;
          $('#w-ov-pass').value = onvifPass() || info.password;
          const chUrl = url;
          const ch = groups.find(g => (g.main || g.sub) === chUrl) || lensGroups.find(g => (g.main || g.sub) === chUrl);
          $('#w-ov-token').value = (ch && ch.profile_token) || (channelInfo && channelInfo.ptz_profile_token) || '';
          toast('URL RTSP y ONVIF puestos en el formulario');
        } else {
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
    let url = t === 'rtsp' ? $('#w-url').value.trim()
      : t === 'file' ? $('#w-file').value.trim() : '';
    let sub = t === 'rtsp' ? $('#w-sub').value.trim() : '';
    let user = t === 'rtsp' ? $('#w-user').value : '';
    let pass = t === 'rtsp' ? $('#w-pass').value : '';

    // Para iCSee/XMEye las credenciales suelen venir dentro de la URL. Si el
    // usuario las dejó ahí y el formulario está vacío, las extraemos para
    // guardarlas también en los campos separados. Y a la inversa: si puso
    // usuario/contraseña en el formulario, las embebemos en la URL para que
    // OpenCV/ffmpeg y la grabación funcionen aunque se pierdan los campos.
    if (t === 'rtsp' && url) {
      const info = icseeInfo(url);
      user = user || info.username || '';
      pass = pass !== '' ? pass : info.password;
      if (url) {
        url = (user || pass) ? fillUrlCredentials(url, user, pass) : url;
      }
      if (sub) {
        sub = (user || pass) ? fillUrlCredentials(sub, user, pass) : sub;
      }
    }

    const payload = {
      name: $('#w-name').value.trim(),
      group: $('#w-group').value.trim() || 'General',
      source_type: t,
      url,
      substream_url: sub,
      username: t === 'rtsp' ? user : '',
      password: t === 'rtsp' ? pass : '',
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
  const rec = cam.recording || {};
  const det = cam.detection || {};
  const alerts = cam.alerts || {};
  const ov = cam.overlay || {};
  const isRtsp = cam.source_type === 'rtsp';
  const qualityOpts = ['high', 'medium', 'low', 'custom'];
  const presetOpts = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];
  openModal(`Ajustes · ${cam.name}`, `
    <div class="form-grid">
      <div class="field"><label>Nombre</label><input id="c-name" value="${esc(cam.name)}"></div>
      <div class="field"><label>Grupo</label><input id="c-group" value="${esc(cam.group || '')}"></div>
      <div class="field"><label>Ubicación</label><input id="c-location" value="${esc(cam.location || '')}" placeholder="Entrada, garaje..."></div>
      <div class="field"><label>Color de tarjeta</label><input id="c-color" value="${esc(cam.color || '')}" placeholder="#3ddc97"></div>
      <div class="field"><label>Etiquetas (coma)</label><input id="c-tags" value="${esc((cam.tags || []).join(','))}" placeholder="exterior,patio"></div>
      <div class="field"><label>Orden en panel</label><input type="number" id="c-order" value="${cam.order || 0}"></div>
      <div class="field"><label>Tipo</label>
        <select id="c-type" disabled>
          ${['rtsp', 'usb', 'file', 'demo'].map(t => `<option value="${t}" ${cam.source_type === t ? 'selected' : ''}>${t.toUpperCase()}</option>`).join('')}
        </select></div>
      ${isRtsp ? `<div class="field"><label>URL principal</label><input id="c-url" value="${esc(cam.url || '')}"></div>
      <div class="field"><label>URL secundaria</label><input id="c-sub" value="${esc(cam.substream_url || '')}"></div>
      <div class="field"><label>Usuario</label><input id="c-user" value="${esc(cam.username || '')}"></div>
      <div class="field"><label>Contraseña</label><input type="password" id="c-pass" value="${esc(cam.password || '')}"></div>` : ''}
      <div class="field grid-span2"><label>Notas</label><input id="c-notes" value="${esc(cam.notes || '')}" placeholder="Texto libre..."></div>
    </div>

    <div class="divider"></div>
    <h4>🎬 Grabación profesional</h4>
    <div class="form-grid">
      <div class="field"><label>Modo</label>
        <select id="c-rec-mode">
          <option value="continuous" ${rec.mode === 'continuous' ? 'selected' : ''}>Continua 24/7</option>
          <option value="motion" ${rec.mode === 'motion' ? 'selected' : ''}>Sólo movimiento</option>
          <option value="smart" ${rec.mode === 'smart' ? 'selected' : ''}>Inteligente (continua + clips)</option>
          <option value="scheduled" ${rec.mode === 'scheduled' ? 'selected' : ''}>Por horario</option>
          <option value="off" ${rec.mode === 'off' ? 'selected' : ''}>Desactivada</option>
        </select></div>
      <div class="field"><label>Calidad</label>
        <select id="c-rec-quality">${qualityOpts.map(q => `<option value="${q}" ${rec.quality === q ? 'selected' : ''}>${q}</option>`).join('')}</select></div>
      <div class="field"><label>CRF (0-51)</label><input type="number" min="0" max="51" id="c-rec-crf" value="${rec.crf ?? 23}"></div>
      <div class="field"><label>Preset x264</label>
        <select id="c-rec-preset">${presetOpts.map(p => `<option value="${p}" ${rec.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="field"><label>Bitrate (vacío=CRF)</label><input id="c-rec-bitrate" value="${esc(rec.bitrate || '')}" placeholder="2500k"></div>
      <div class="field"><label>Resolución (ancho x alto, 0=original)</label><div class="row"><input type="number" min="0" id="c-rec-w" value="${rec.width || 0}"><input type="number" min="0" id="c-rec-h" value="${rec.height || 0}"></div></div>
      <div class="field"><label>FPS destino (0=original)</label><input type="number" min="0" max="60" id="c-rec-fps" value="${rec.fps || 0}"></div>
      <div class="field"><label>Segmento (s)</label><input type="number" min="10" id="c-rec-seg" value="${rec.segment_seconds ?? 300}"></div>
      <div class="field"><label>Pre / post (s)</label><div class="row"><input type="number" min="0" id="c-rec-pre" value="${rec.pre_seconds ?? 5}"><input type="number" min="1" id="c-rec-post" value="${rec.post_seconds ?? 10}"></div></div>
      <div class="field"><label>Máx. duración evento (s)</label><input type="number" min="30" id="c-rec-max" value="${rec.max_event_seconds ?? 600}"></div>
      <div class="field"><label>Códec / audio</label><div class="row">
        <select id="c-rec-codec"><option value="copy" ${rec.codec === 'copy' ? 'selected' : ''}>copy</option><option value="h264" ${rec.codec === 'h264' ? 'selected' : ''}>h264</option></select>
        <label class="checkline"><input type="checkbox" id="c-rec-audio" ${rec.audio ? 'checked' : ''}> audio</label>
      </div></div>
      <div class="field"><label>Retención propia (días, 0=global)</label><input type="number" min="0" max="365" id="c-rec-ret" value="${rec.retention_days ?? 0}"></div>
      <div class="field grid-span2">${scheduleField('c-rec-schedule', rec.schedule, 'Grabación continua sólo en estas franjas (modo por horario).')}</div>
    </div>

    <div class="divider"></div>
    <h4>🧠 Detección inteligente</h4>
    <div class="form-grid">
      <div class="field"><label>Sensibilidad</label><input type="number" min="1" max="100" id="c-det-sens" value="${det.sensitivity ?? 55}"></div>
      <div class="field"><label>Área mínima</label><input type="number" min="0" id="c-det-area" value="${det.min_area ?? 1200}"></div>
      <div class="field"><label>FPS análisis</label><input type="number" min="1" max="30" id="c-det-fps" value="${det.fps ?? 6}"></div>
      <div class="field"><label>Ancho análisis</label><input type="number" min="160" id="c-det-width" value="${det.detect_width ?? 640}"></div>
      <div class="field"><label>Cooldown (s)</label><input type="number" min="0" id="c-det-cool" value="${det.cooldown_seconds ?? 20}"></div>
      <div class="field"><label>Máx eventos/min (0=sín límite)</label><input type="number" min="0" id="c-det-maxmin" value="${det.max_events_per_minute ?? 0}"></div>
      <div class="field"><label>Zonas</label><button class="btn sm" id="c-zones">Editar zonas</button></div>
      <div class="field grid-span2">${scheduleField('c-det-schedule', det.schedule, 'La detección sólo está activa en estas franjas.')}</div>
      <label class="checkline"><input type="checkbox" id="c-det-light" ${det.ignore_light_change !== false ? 'checked' : ''}> Ignorar cambios globales de luz</label>
      <label class="checkline"><input type="checkbox" id="c-det-privacy" ${det.tamper_enabled ? 'checked' : ''}> Detectar cámara tapada / manipulación</label>
      <div class="field"><label>Sensibilidad taponazo</label><input type="number" min="1" max="100" id="c-det-tamper" value="${det.tamper_sensitivity ?? 40}"></div>
      <label class="checkline"><input type="checkbox" id="c-det-ai" ${det.ai_enabled ? 'checked' : ''}> Confirmar con IA (personas/vehículos/mascotas)</label>
      <div class="field"><label>Modelo</label><input id="c-det-model" value="${esc(det.ai_model || 'yolov8n.pt')}"></div>
      <div class="field"><label>Clases (coma)</label><input id="c-det-labels" value="${esc((det.ai_labels || []).join(','))}"></div>
      <div class="field"><label>Confianza</label><input type="number" min="0.05" max="0.95" step="0.05" id="c-det-conf" value="${det.ai_confidence ?? 0.45}"></div>
      <div class="field"><label>Analizar cada N frames</label><input type="number" min="1" max="10" id="c-det-every" value="${det.ai_every_n ?? 3}"></div>
      <div class="field"><label>Imagen IA (px)</label><input type="number" min="320" id="c-det-imgsz" value="${det.ai_imgsz ?? 640}"></div>
    </div>

    <div class="divider"></div>
    <h4>🔔 Alertas premium</h4>
    <div class="form-grid">
      <label class="checkline"><input type="checkbox" id="c-alerts" ${alerts.enabled ? 'checked' : ''}> Enviar avisos</label>
      <label class="checkline"><input type="checkbox" id="c-away" ${alerts.only_when_away ? 'checked' : ''}> Sólo fuera de casa</label>
      <div class="field"><label>Canales (vacío=todos)</label><input id="c-channels" value="${esc((alerts.channels || []).join(','))}" placeholder="telegram,ntfy,discord,email"></div>
      <div class="field"><label>Sólo etiquetas (vacío=todas)</label><input id="c-labels" value="${esc((alerts.labels || []).join(','))}" placeholder="person,car"></div>
      <div class="field"><label>Máx avisos/hora (0=sín límite)</label><input type="number" min="0" id="c-maxhour" value="${alerts.max_per_hour ?? 0}"></div>
    </div>

    <div class="divider"></div>
    <h4>🖼️ Marcas de agua / overlay</h4>
    <div class="form-grid">
      <label class="checkline"><input type="checkbox" id="c-ov" ${ov.enabled ? 'checked' : ''}> Mostrar overlay</label>
      <label class="checkline"><input type="checkbox" id="c-ov-ts" ${ov.timestamp !== false ? 'checked' : ''}> fecha/hora</label>
      <label class="checkline"><input type="checkbox" id="c-ov-name" ${ov.camera_name !== false ? 'checked' : ''}> nombre</label>
      <label class="checkline"><input type="checkbox" id="c-ov-loc" ${ov.location ? 'checked' : ''}> ubicación</label>
      <div class="field"><label>Posición</label><select id="c-ov-pos">
        ${['top-left','top-right','bottom-left','bottom-right'].map(p => `<option value="${p}" ${ov.position === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select></div>
      <div class="field"><label>Tamaño</label><input type="number" min="0.3" max="2" step="0.1" id="c-ov-scale" value="${ov.font_scale ?? 0.7}"></div>
    </div>

    <div class="divider"></div>
    <div class="row" style="justify-content:space-between">
      <button class="btn danger" id="c-delete">Eliminar cámara</button>
      <div class="row">
        <button class="btn ghost" id="c-cancel">Cancelar</button>
        <button class="btn primary" id="c-save">Guardar</button>
      </div>
    </div>`, { wide: true });

  $('#c-cancel').onclick = closeModal;
  $('#c-zones').onclick = () => zoneEditor(cam);
  $('#c-save').onclick = async () => {
    let url = $('#c-url') ? $('#c-url').value.trim() : (cam.url || '');
    let sub = $('#c-sub') ? $('#c-sub').value.trim() : (cam.substream_url || '');
    let user = $('#c-user') ? $('#c-user').value : (cam.username || '');
    let pass = $('#c-pass') ? $('#c-pass').value : (cam.password || '');
    // Mantiene credenciales tanto en campos como dentro de la URL.
    if (url) {
      const info = icseeInfo(url);
      user = user || info.username || '';
      pass = pass !== '' ? pass : info.password;
      url = (user || pass) ? fillUrlCredentials(url, user, pass) : url;
    }
    if (sub) sub = (user || pass) ? fillUrlCredentials(sub, user, pass) : sub;
    const payload = {
      name: $('#c-name').value,
      group: $('#c-group').value,
      location: $('#c-location').value,
      tags: $('#c-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      notes: $('#c-notes').value,
      color: $('#c-color').value.trim(),
      order: +$('#c-order').value || 0,
    };
    if ($('#c-url')) payload.url = url;
    if ($('#c-sub')) payload.substream_url = sub;
    if ($('#c-user')) { payload.username = user; payload.password = pass; }
    payload.recording = {
      mode: $('#c-rec-mode').value,
      quality: $('#c-rec-quality').value,
      crf: +$('#c-rec-crf').value,
      preset: $('#c-rec-preset').value,
      bitrate: $('#c-rec-bitrate').value.trim(),
      width: +$('#c-rec-w').value, height: +$('#c-rec-h').value,
      fps: +$('#c-rec-fps').value,
      segment_seconds: +$('#c-rec-seg').value,
      pre_seconds: +$('#c-rec-pre').value,
      post_seconds: +$('#c-rec-post').value,
      max_event_seconds: +$('#c-rec-max').value,
      codec: $('#c-rec-codec').value,
      audio: $('#c-rec-audio').checked,
      retention_days: +$('#c-rec-ret').value,
      schedule: parseScheduleText($('#c-rec-schedule').value),
    };
    payload.detection = {
      enabled: cam.detection?.enabled ?? true,
      sensitivity: +$('#c-det-sens').value,
      min_area: +$('#c-det-area').value,
      fps: +$('#c-det-fps').value,
      detect_width: +$('#c-det-width').value,
      cooldown_seconds: +$('#c-det-cool').value,
      max_events_per_minute: +$('#c-det-maxmin').value,
      ignore_light_change: $('#c-det-light').checked,
      tamper_enabled: $('#c-det-privacy').checked,
      tamper_sensitivity: +$('#c-det-tamper').value,
      schedule: parseScheduleText($('#c-det-schedule').value),
      ai_enabled: $('#c-det-ai').checked,
      ai_model: $('#c-det-model').value,
      ai_labels: $('#c-det-labels').value.split(',').map(s => s.trim()).filter(Boolean),
      ai_confidence: +$('#c-det-conf').value,
      ai_every_n: +$('#c-det-every').value,
      ai_imgsz: +$('#c-det-imgsz').value,
    };
    payload.alerts = {
      enabled: $('#c-alerts').checked,
      only_when_away: $('#c-away').checked,
      channels: $('#c-channels').value.split(',').map(s => s.trim()).filter(Boolean),
      labels: $('#c-labels').value.split(',').map(s => s.trim()).filter(Boolean),
      max_per_hour: +$('#c-maxhour').value,
    };
    payload.overlay = {
      enabled: $('#c-ov').checked,
      timestamp: $('#c-ov-ts').checked,
      camera_name: $('#c-ov-name').checked,
      location: $('#c-ov-loc').checked,
      position: $('#c-ov-pos').value,
      font_scale: +$('#c-ov-scale').value,
    };
    await api(`/cameras/${id}`, { method: 'PATCH', body: payload });
    toast('Cámara actualizada'); closeModal(); refresh(true);
  };
  $('#c-delete').onclick = () => confirmModal('Eliminar cámara',
    `Se eliminará "${cam.name}". Puedes borrar también sus grabaciones.`, async () => {
      await api(`/cameras/${id}?purge=true`, { method: 'DELETE' });
      toast('Cámara eliminada'); refresh(true);
    });
}

document.addEventListener('DOMContentLoaded', boot);
