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

/* Versión de la interfaz: se muestra en Ajustes y se usa para invalidar
   versiones viejas cacheadas por la PWA o por un .exe anterior. */
const UI_VERSION = '2026-08-31.1';

function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
  catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ }
}
function lsJson(key, fallback = null) {
  try { const v = lsGet(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}

async function api(path, opts = {}) {
  // Timeout de red: si el backend se queda colgado, la interfaz nunca debe
  // quedarse "haciendo nada" (por eso los tabs parecían muertos).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 15000);
  let res;
  try {
    res = await fetch('/api' + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err && err.name === 'AbortError' ? `Tiempo de espera agotado (${path})` : (err.message || 'Sin conexión con el servidor'));
  }
  clearTimeout(timer);
  if (res.status === 401) { if (!opts.silent401) toast('Sesión no autenticada', 'err'); throw new Error('401'); }
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
/* PWA: instalación, push y sonido de alarma                           */
/* ------------------------------------------------------------------ */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let alarmCtx = null;
function playAlarm(style = 'siren') {
  if (state.alarmMuted) return;
  try {
    alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (alarmCtx.state === 'suspended') alarmCtx.resume();
    const now = alarmCtx.currentTime;
    const gain = alarmCtx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(state.settings.notifications?.alarm_volume ?? 0.65, now + 0.02);
    gain.gain.setValueAtTime(state.settings.notifications?.alarm_volume ?? 0.65, now + 1.0);
    gain.gain.linearRampToValueAtTime(0, now + 1.35);
    gain.connect(alarmCtx.destination);
    if (style === 'beep') {
      for (let i = 0; i < 3; i++) {
        const os = alarmCtx.createOscillator();
        os.type = 'square';
        os.frequency.value = 880;
        os.connect(gain);
        os.start(now + i * 0.35);
        os.stop(now + i * 0.35 + 0.18);
      }
    } else {
      const os = alarmCtx.createOscillator();
      os.type = 'sawtooth';
      os.frequency.setValueAtTime(650, now);
      os.frequency.linearRampToValueAtTime(1250, now + 0.45);
      os.frequency.linearRampToValueAtTime(650, now + 0.9);
      os.frequency.linearRampToValueAtTime(1250, now + 1.35);
      os.connect(gain);
      os.start(now);
      os.stop(now + 1.4);
    }
  } catch { /* sin audio disponible */ }
}

async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const st = state.push.status;
  if (!st || !st.available || !st.enabled || !st.public_key) return false;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(st.public_key),
    });
    await api('/push/subscribe', {
      method: 'POST',
      body: { subscription: sub.toJSON(), user_agent: navigator.userAgent },
    });
    state.push.subscriber = sub;
    return true;
  } catch (e) {
    console.error('No se pudo suscribir a push:', e);
    return false;
  }
}

async function setupPush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    state.push.status = await api('/push/status', { silent401: true });
    await subscribePush();
  } catch (e) { /* sin backend push accesible */ }
}

function setupPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    const btn = $('#btn-install');
    if (btn) { btn.style.display = ''; btn.onclick = async () => {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
      btn.style.display = 'none';
    }; }
  });
  window.addEventListener('appinstalled', () => {
    toast('Vigía instalado. Ya puedes lanzarlo desde tu dispositivo.');
    const btn = $('#btn-install');
    if (btn) btn.style.display = 'none';
  });
  if (navigator.standalone) {
    const btn = $('#btn-install');
    if (btn) btn.style.display = 'none';
  }
  const alarmBtn = $('#btn-alarm');
  if (alarmBtn) alarmBtn.onclick = () => {
    state.alarmMuted = !state.alarmMuted;
    lsSet('vigia-alarm-muted', state.alarmMuted ? '1' : '0');
    renderTopbar();
    toast(state.alarmMuted ? 'Sonido de alarma silenciado' : 'Sonido de alarma activado');
  };
  // Puede venir de una página abierta antes de recargar: al autenticarnos ya
  // hay permiso, así que intentamos suscribir tras el arranque.
  setupPush();
}

function alarmWanted(ev) {
  const n = state.settings.notifications || {};
  if (!n.alarm_enabled || state.alarmMuted) return false;
  const cam = state.cameras.find(c => c.id === ev.camera_id);
  if (cam?.alerts?.alarm_enabled === false) return false;
  const labels = (cam?.alerts?.labels || []).map(s => String(s).toLowerCase());
  if (labels.length && !labels.includes(String(ev.label || 'motion').toLowerCase())) return false;
  return true;
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
  multiview: { layout: 'auto', order: lsJson('vigia-multiview-order', []) },
  auth: { enabled: false, user: null, running: false },
  alarmMuted: lsGet('vigia-alarm-muted') === '1',
  push: { status: null, subscriber: null },
  installPrompt: null,
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
let _confirmYes = null;
function closeModal() {
  _confirmYes = null;
  const modal = $('#modal');
  const modalBody = $('#modal-body');
  if (modal) modal.hidden = true;
  if (modalBody) modalBody.innerHTML = '';
}

function confirmModal(title, text, onYes) {
  _confirmYes = onYes;
  openModal(title, `<p>${esc(text)}</p>
    <div class="row" style="justify-content:flex-end;margin-top:18px">
      <button class="btn ghost" data-close>Cancelar</button>
      <button class="btn danger" data-yes>Confirmar</button>
    </div>`);
}

/* ------------------------------------------------------------------ */
/* Arranque y navegación                                               */
/* ------------------------------------------------------------------ */
// Configurar el modal IMMEDIATELY para evitar problemas si boot() falla
(function() {
  const modal = $('#modal');
  const modalClose = $('#modal-close');
  const modalBody = $('#modal-body');

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

  // Delegación única para los diálogos de confirmación. Antes este listener se
  // añadía una vez por confirmModal y quedaba acumulado (podía ejecutar un
  // confirmación vieja al usar el modal después).
  if (modalBody) {
    modalBody.addEventListener('click', e => {
      const t = e.target;
      const isClose = t && t.hasAttribute && (t.hasAttribute('data-close') || t.id === 'modal-close');
      if (isClose) { _confirmYes = null; closeModal(); return; }
      if (t && t.hasAttribute && t.hasAttribute('data-yes')) {
        const fn = _confirmYes;
        _confirmYes = null;
        closeModal();
        if (typeof fn === 'function') fn();
      }
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  // Failsafe: ocultar modal después de 500ms por si algo lo hizo visible
  setTimeout(() => {
    const m = $('#modal');
    if (m && !m.hidden) {
      const body = m.querySelector('.modal-body');
      if (body && !body.innerHTML.trim()) m.hidden = true;
    }
  }, 500);
})();

async function startApp() {
  // Si la app ya arrancó (p. ej. sesión caducada y vuelta a entrar), sólo
  // refrescamos; no duplicamos listeners ni intervalos.
  if (state.auth.running) { await refresh(true); return; }
  state.auth.running = true;
  // Los event listeners del modal ya están configurados arriba
  try {
    $('#btn-add').onclick = () => cameraWizard();
    $('#btn-refresh').onclick = () => refresh(true);
    const diagBtn = $('#btn-diagnose');
    if (diagBtn) {
      diagBtn.style.display = '';
      diagBtn.onclick = () => showDiagnostics();
    }
    $('#btn-away').onclick = async () => {
      const away = !state.settings.general?.away;
      await api('/system/away', { method: 'POST', body: { value: away } });
      state.settings.general = { ...(state.settings.general || {}), away };
      renderTopbar();
      toast(away ? 'Modo fuera de casa activado' : 'Modo en casa');
    };
    $$('#btn-logout').forEach(btn => btn.onclick = async () => {
      try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ya caducó */ }
      location.hash = '';
      location.reload();
    });

    window.addEventListener('hashchange', route);

    await refresh(true);
    await route();
    setupPush();
    setInterval(() => refresh(false), 5000);
    setInterval(checkNewEvents, 6000);
  } catch (err) {
    console.error('Error durante el arranque:', err);
    // Asegurarse de que el modal esté oculto si hubo un error
    closeModal();
  }
}

function showLogin() {
  let ov = $('#auth-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'auth-overlay';
    ov.innerHTML = `
      <div class="auth-card">
        <div class="auth-logo">🎥</div>
        <h2>Vigía Pro</h2>
        <p class="muted">Introduce tu usuario y contraseña.</p>
        <form id="auth-form">
          <div class="field"><label>Usuario</label><input id="login-user" autocomplete="username" required></div>
          <div class="field"><label>Contraseña</label><input id="login-pass" type="password" autocomplete="current-password" required></div>
          <div class="field" style="display:none"><label>Código 2FA</label><input id="login-code" inputmode="numeric" autocomplete="one-time-code"></div>
          <button class="btn primary" id="login-btn" type="submit" style="width:100%">Entrar</button>
          <div id="login-err" class="muted" style="color:#ff6b6b;margin-top:8px"></div>
        </form>
      </div>`;
    document.body.appendChild(ov);
  }
  ov.hidden = false;
  $('#login-user').focus();
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true; btn.textContent = 'Comprobando…';
    $('#login-err').textContent = '';
    const body = { username: $('#login-user').value.trim(), password: $('#login-pass').value };
    const code = $('#login-code').value.trim();
    if (code) body.code = code;
    try {
      const r = await api('/auth/login', { method: 'POST', body, silent401: true });
      state.auth.user = r;
      ov.remove();
      await startApp();
    } catch (err) {
      // Si el usuario tiene 2FA activado, muestra el campo de código.
      $('#login-code').parentElement.style.display = '';
      $('#login-err').textContent = err.message === '401' ? 'Credenciales o código incorrectos.' : (err.message || 'Error al entrar');
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  };
}

async function boot() {
  console.info(`Vigía UI ${UI_VERSION}`);
  document.title = `Vigía Pro · UI ${UI_VERSION}`;
  try { document.documentElement.dataset.uiVersion = UI_VERSION; } catch (e) { /* sin atributos */ }
  setupPwa();
  // Navegación robusta: se vincula antes de la autenticación para que los
  // tabs funcionen aunque algo falle después al cargar los datos.
  // Usamos delegación y cambiamos la vista directamente (showView), en vez de
  // depender de que location.hash ya se haya actualizado al llamar a route().
  document.addEventListener('click', (e) => {
    const tab = e.target && e.target.closest ? e.target.closest('#tabs .tab') : null;
    if (!tab || !tab.dataset.view) return;
    const view = tab.dataset.view;
    const targetHash = '#/' + view;
    try { if (location.hash !== targetHash) location.hash = targetHash; } catch { /* hash no disponible */ }
    showView(view);
  });
  try {
    const st = await api('/auth/status', { silent401: true });
    state.auth.enabled = !!st.auth_enabled;
    if (state.auth.enabled) {
      try {
        state.auth.user = await api('/auth/me', { silent401: true });
      } catch {
        showLogin();
        return;
      }
    }
  } catch (err) {
    console.error('No se pudo comprobar el estado de autenticación:', err);
  }
  await startApp();
}

async function showView(view, param = null) {
  state.view = view || 'dashboard';
  state.cameraId = state.view === 'camera' ? param : null;
  $$('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === state.view));
  try {
    await render();
  } catch (err) {
    console.error('Error cargando vista', state.view, err);
    $('#view').innerHTML = `<div class="panel empty"><span class="big">⚠️</span><p>No se pudo cargar la vista: ${esc(err.message)}</p><button class="btn" id="retry-view">Reintentar</button></div>`;
    const retry = $('#retry-view');
    if (retry) retry.onclick = () => showView(state.view, state.cameraId);
  }
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, param] = hash.split('/');
  await showView(view || 'dashboard', param);
}

let _refreshBusy = false;
async function refresh(full = false) {
  // Si un refresco anterior sigue en vuelo, no lanzamos otro: así los sondeos
  // nunca se acumulan ni saturan el backend (causa de esperas y errores).
  if (_refreshBusy) return;
  _refreshBusy = true;
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
    if (err.message === '401' && state.auth.enabled) showLogin();
  } finally {
    _refreshBusy = false;
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
  const logout = $('#btn-logout');
  if (logout) {
    logout.style.display = state.auth.enabled ? '' : 'none';
    logout.title = state.auth.user?.username?.startsWith('token:') ? 'Token de API no intercambiable' : 'Cerrar sesión';
  }
  const alarm = $('#btn-alarm');
  if (alarm) {
    alarm.textContent = state.alarmMuted ? '🔕' : '🔔';
    alarm.title = state.alarmMuted ? 'Activar sonido de alarma' : 'Silenciar alarma';
    alarm.classList.toggle('muted', state.alarmMuted);
  }
  const install = $('#btn-install');
  if (install && !state.installPrompt) install.style.display = 'none';
  const dbg = $('#btn-diagnose');
  if (dbg) {
    const errCount = cams.filter(c => c.health?.last_error).length;
    dbg.textContent = errCount ? `🩺 ${errCount}` : '🩺';
    dbg.classList.toggle('muted', !errCount);
    dbg.title = errCount ? `${errCount} cámara(s) con error. Clic para ver el detalle.` : 'Diagnóstico y errores';
  }
}

function countDuplicateCameras(cams) {
  const seen = new Map(); let dup = 0;
  for (const c of cams || []) {
    let key;
    if (c.source_type === 'dvrip' && (c.dvrip || {}).host) {
      key = `dvrip:${c.dvrip.host.toLowerCase()}:${+c.dvrip.channel}`;
    } else if (c.url) {
      const host = icseeInfo(c.url).host;
      const ch = /[?&_]channel=(\d+)/i.exec(c.url || '');
      key = host ? (ch ? `ch:${host}:${ch[1]}` : `url:${host}:${c.url}`) : `url:${c.url}`;
    } else key = c.id || '';
    if (seen.has(key)) dup++;
    else seen.set(key, c);
  }
  return dup;
}

async function showDiagnostics() {
  openModal('🩺 Diagnóstico y errores', '<div class="muted"><span class="spinner"></span> Leyendo logs y dependencias…</div>', { wide: true });
  try {
    const d = await api('/system/diagnostics');
    const dupCount = countDuplicateCameras(d.cameras || []);
    const body = $('#modal-body');
    const depRow = (name, ok, detail = '') => `<tr><td>${esc(name)}</td><td style="color:${ok ? 'var(--ok,#3ddc97)' : 'var(--warn,#ffb454)'}">${ok ? '✓' : '⚠'}</td><td class="muted">${esc(detail || '')}</td></tr>`;
    const camRows = (d.cameras || []).map(c => `<tr>
        <td><b>${esc(c.name)}</b><div class="muted">${esc(c.source_type || '')}</div></td>
        <td><span class="badge state ${esc(c.state)}">${esc(c.state || '')}</span></td>
        <td>${esc(c.last_error || '—')}</td>
        <td>${c.reconnects || 0}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">Sin cámaras.</td></tr>';
    const logLines = (d.log_tail || []).map(l => esc(l)).join('\n') || '(sin líneas)';
    body.innerHTML = `
      ${dupCount ? `<div style="background:rgba(255,180,84,.12);border:1px solid var(--warn,#ffb454);border-radius:8px;padding:8px 10px;margin-bottom:10px">
        ⚠️ Hay <b>${dupCount}</b> cámara(s) duplicada(s) del mismo dispositivo-canal. Usa <b>🧹 Limpiar duplicados</b> para conservar una sola por lente.
      </div>` : ''}
      <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">
        <div class="item"><b>Carpeta de datos</b><div class="meta">${esc(d.data_dir)}</div><div class="meta">${d.data_dir_writable ? '✓ escribible' : '⚠ no escribible'}</div></div>
        <div class="item"><b>ffmpeg</b><div class="meta">${d.ffmpeg ? '✓ ' + esc(d.ffmpeg) : '⚠ no encontrado (usará imageio si está instalado)'}</div></div>
        <div class="item"><b>ONVIF</b><div class="meta">${d.onvif_available ? '✓' : '⚠ ' + esc(d.onvif_hint || 'no instalado')}</div></div>
        <div class="item"><b>DVRIP/NetIP</b><div class="meta">${d.dvrip_available ? '✓ soporte iCSee multi-lente' : '⚠ ' + esc(d.dvrip_hint || 'no instalado')}</div></div>
        <div class="item"><b>Web Push</b><div class="meta">${d.pywebpush_available ? '✓' : '⚠ ' + esc(d.pywebpush_hint || 'no instalado')}</div></div>
        <div class="item"><b>IA YOLO</b><div class="meta">${d.ai_available ? '✓' : '⚠ opcional, no instalada'}</div></div>
      </div>
      <div class="divider"></div>
      <h4>Estado y errores de cámaras</h4>
      <table><tr><th>Cámara</th><th>Estado</th><th>Último error</th><th>Reconex.</th></tr>${camRows}</table>
      <div class="divider"></div>
      <div class="row" style="justify-content:space-between">
        <h4 style="margin:0">Log ${esc(d.version || '')}</h4>
        <div class="row" style="gap:6px">
          <button class="btn sm muted" id="diag-dedupe">🧹 Limpiar duplicados</button>
          <button class="btn sm" id="diag-refresh">⟳ Refrescar</button>
          <button class="btn sm" id="diag-copy">📋 Copiar resumen</button>
          <button class="btn sm" id="diag-download">⬇ Descargar vigia.log</button>
        </div>
      </div>
      <pre class="logview">${logLines}</pre>
      ${(d.startup_error_tail || []).length ? `<details style="margin-top:8px"><summary>Errores de arranque (startup_error.log)</summary><pre class="logview">${(d.startup_error_tail || []).map(esc).join('\n')}</pre></details>` : ''}`;
    $('#diag-dedupe').onclick = async () => {
      if (!confirm('¿Quitar las cámaras duplicadas del mismo dispositivo-canal? Se conservará la copia mejor configurada.')) return;
      const btn = $('#diag-dedupe');
      btn.disabled = true;
      btn.textContent = 'Limpiando…';
      try {
        const r = await api('/cameras/dedupe', { method: 'POST' });
        if (r.count > 0) {
          toast(`🧹 ${r.count} cámara(s) duplicada(s) eliminadas. Quedan ${r.remaining}.`, 'ok');
          await refresh(true);
          showDiagnostics();
        } else {
          toast('No hay cámaras duplicadas.', 'ok');
          btn.disabled = false;
          btn.textContent = '🧹 Limpiar duplicados';
        }
      } catch (e) {
        toast(e.message || 'No se pudieron limpiar', 'err');
        btn.disabled = false;
        btn.textContent = '🧹 Limpiar duplicados';
      }
    };
    $('#diag-refresh').onclick = () => showDiagnostics();
    $('#diag-copy').onclick = async () => {
      try {
        const summary = {
          version: d.version, python: d.python, platform: d.platform,
          data_dir: d.data_dir, data_dir_writable: d.data_dir_writable,
          ffmpeg: d.ffmpeg, opencv: d.opencv,
          onvif: d.onvif_available, dvrip: d.dvrip_available,
          pywebpush: d.pywebpush_available, ai: d.ai_available,
          cameras: (d.cameras || []).map(c => ({ name: c.name, state: c.state, last_error: c.last_error, reconnects: c.reconnects })),
          errors: d.errors, log_tail: (d.log_tail || []).slice(-40),
        };
        await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
        toast('Resumen de diagnóstico copiado al portapapeles');
      } catch { toast('No se pudo copiar', 'err'); }
    };
    $('#diag-download').onclick = async () => {
      try {
        const r = await api('/system/logs/tail?file=vigia.log&lines=5000');
        const blob = new Blob([(r.lines || []).join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `vigia-${todayStr()}.log`;
        a.click();
      } catch (e) { toast(e.message || 'No se pudo descargar', 'err'); }
    };
  } catch (e) {
    $('#modal-body').innerHTML = `<div class="muted">No se pudo leer el diagnóstico: ${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Vistas                                                              */
/* ------------------------------------------------------------------ */
const VIEW_LABELS = {
  dashboard: 'Directo', multiview: 'Muro', camera: 'cámara',
  events: 'Eventos', recordings: 'Grabaciones', reports: 'Informes', settings: 'Ajustes',
};
function renderSkeleton(view) {
  // Pintamos inmediatamente una vista de carga. Así, aunque la API tarde o
  // esté caída, el usuario ve que la pestaña SÍ ha cambiado en lugar de una
  // pantalla congelada.
  const v = $('#view');
  if (!v) return;
  const label = VIEW_LABELS[view] || 'vista';
  v.innerHTML = `<div class="panel empty"><span class="spinner"></span><p>Cargando ${esc(label)}…</p></div>`;
}

async function render() {
  const view = state.view;
  renderSkeleton(view);
  if (view === 'dashboard') return await renderDashboard();
  if (view === 'multiview') return await renderMultiview();
  if (view === 'camera') return await renderCamera();
  if (view === 'events') return await renderEvents();
  if (view === 'recordings') return await renderRecordings();
  if (view === 'reports') return await renderReports();
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

  // Pintamos las tarjetas YA con los datos ya cargados en `state` (sin esperar
  // otra llamada) y rellenamos los KPI del panel en segundo plano: la vista
  // "Directo" aparece al instante aunque el dashboard tarde.
  const online = state.cameras.filter(c => c.health?.state === 'running').length;
  const recording = state.cameras.filter(c => c.health?.recording).length;
  const dashFallback = {
    cameras: state.cameras.length, online, recording,
    events_today: 0, by_label: {}, storage: state.info.storage || {},
  };

  const groups = {};
  state.cameras
    .slice().sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach(c => { (groups[c.group || 'General'] ||= []).push(c); });

  const kpiMarkup = d => `
  <div class="kpis" id="kpis">
    <div class="kpi"><span class="label">Cámaras</span><b>${d.online ?? 0}/${d.cameras ?? state.cameras.length}</b><span class="sub">en directo</span></div>
    <div class="kpi"><span class="label">Grabación</span><b>${d.recording ?? 0}</b><span class="sub">ahora mismo</span></div>
    <div class="kpi"><span class="label">Hoy</span><b>${d.events_today ?? 0}</b><span class="sub">eventos <span class="muted">${Object.entries(d.by_label || {}).map(([k, v]) => `${k}:${v}`).join(' · ')}</span></span></div>
    <div class="kpi"><span class="label">Almacenamiento</span><b>${fmtBytes(((d.storage?.recordings?.bytes || 0) + (d.storage?.clips?.bytes || 0)))}</b><span class="sub">${fmtBytes(d.storage?.disk?.free || 0)} libres</span></div>
  </div>`;

  view.innerHTML = kpiMarkup(dashFallback) + Object.entries(groups).map(([group, cams]) => `
    <div class="section-title">${esc(group)}</div>
    <div class="grid cams">${cams.map(camCard).join('')}</div>
  `).join('');

  // KPI del backend en segundo plano (no bloquea la vista ni los streams).
  api('/system/dashboard')
    .then(d => {
      state.dash = d;
      const k = $('#kpis');
      if (k) k.outerHTML = kpiMarkup(d);
    })
    .catch(() => { /* el panel no debe romperse si falla */ });

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
    const del = card.querySelector('[data-act="del"]');
    if (del) del.onclick = e => {
      e.stopPropagation();
      const id = card.dataset.cam;
      const cam = state.cameras.find(c => c.id === id);
      confirmModal('Eliminar cámara',
        `Se eliminará "${cam?.name || id}". Las grabaciones existentes se conservan.`,
        async () => {
          try {
            await api(`/cameras/${id}`, { method: 'DELETE' });
            toast('Cámara eliminada');
            refresh(true);
          } catch (err) {
            toast(err.message || 'No se pudo eliminar la cámara', 'err');
          }
        });
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
      <button class="btn sm ghost" data-act="del" title="Eliminar cámara">🗑</button>
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
  $$('[data-cam]', $('#mw-grid')).forEach(cell => {
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
        · ${esc(cam.health?.resolution || '')} · grabación ${recMode} · ${quality}
        ${cam.detection?.analytics?.enabled || cam.health?.tracks ? `· 👁 ${cam.health?.tracks ?? 0} objeto(s)` : ''}</div>
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

function lineEditor(cam) {
  const base = cam.detection?.analytics || {};
  const lines = JSON.parse(JSON.stringify(base.lines || []));
  let pending = [];
  let adding = false;
  openModal('Líneas de cruce', `
    <p class="muted">Haz dos clics para dibujar una línea. Cuando un objeto la cruce se creará un evento
      <b>line_cross</b> (requiere IA activa para objetos fiables).</p>
    <div class="zone-editor"><canvas id="line-canvas"></canvas></div>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="line-add">➕ Añadir línea</button>
      <button class="btn ghost" id="line-clear">Borrar todas</button>
      <span class="muted" id="line-count"></span>
    </div>
    <div id="line-list" style="margin-top:10px"></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" id="line-cancel">Cancelar</button>
      <button class="btn primary" id="line-save">Guardar líneas</button>
    </div>`, { wide: true });

  const canvas = $('#line-canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  const rows = $('#line-list');

  function refreshRows() {
    rows.innerHTML = lines.map((l, i) => `
      <div class="row" style="gap:6px;margin-bottom:6px;align-items:center">
        <input class="line-name" data-i="${i}" value="${esc(l.name || ('Línea ' + (i+1)))}" style="flex:1">
        <select class="line-dir" data-i="${i}">
          <option value="both" ${l.direction !== 'in' && l.direction !== 'out' ? 'selected' : ''}>Ambos sentidos</option>
          <option value="in" ${l.direction === 'in' ? 'selected' : ''}>Entrada</option>
          <option value="out" ${l.direction === 'out' ? 'selected' : ''}>Salida</option>
        </select>
        <label class="checkline"><input type="checkbox" class="line-on" data-i="${i}" ${l.enabled !== false ? 'checked' : ''}> activa</label>
        <button class="btn sm ghost" data-line-del="${i}">🗑</button>
      </div>`).join('') || '<div class="muted">Aún no hay líneas.</div>';
    $$('.line-name', rows).forEach(inp => inp.onchange = e => {
      lines[+e.target.dataset.i].name = e.target.value.trim() || ('Línea ' + ((+e.target.dataset.i) + 1));
      draw(); refreshRows();
    });
    $$('.line-dir', rows).forEach(sel => sel.onchange = e => {
      lines[+e.target.dataset.i].direction = e.target.value;
    });
    $$('.line-on', rows).forEach(chk => chk.onchange = e => {
      lines[+e.target.dataset.i].enabled = e.target.checked;
      draw();
    });
    $$('[data-line-del]', rows).forEach(btn => btn.onclick = e => {
      lines.splice(+e.target.dataset.lineDel, 1);
      refreshRows(); draw();
    });
    $('#line-count').textContent = `${lines.length} línea(s)${adding ? ' · pulsa dos puntos en la imagen' : ''}`;
  }

  function draw() {
    if (!img.complete || !img.naturalWidth) return;
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pt = p => [p[0] * canvas.width, p[1] * canvas.height];
    lines.forEach(l => {
      const p1 = pt(l.p1), p2 = pt(l.p2);
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
      ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 3; ctx.setLineDash([]); ctx.stroke();
      [p1, p2].forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fillStyle = '#ffb454'; ctx.fill(); });
    });
    if (pending.length) {
      const p1 = pt(pending[0]);
      ctx.beginPath(); ctx.arc(p1[0], p1[1], 6, 0, 7); ctx.fillStyle = '#ffb454'; ctx.fill();
      if (pending.length > 1) {
        const p2 = pt(pending[1]);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
        ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 3; ctx.stroke();
      }
    }
  }

  img.onload = draw;
  img.src = `/api/stream/${cam.id}/snapshot.jpg?force=true&t=${Date.now()}`;
  img.onerror = () => toast('No se pudo cargar la imagen de la cámara', 'err');

  canvas.onclick = e => {
    if (!adding) return;
    const r = canvas.getBoundingClientRect();
    pending.push([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
    if (pending.length === 2) {
      const id = 'line_' + Math.random().toString(36).slice(2, 10);
      lines.push({
        id, name: 'Línea ' + (lines.length + 1), enabled: true,
        direction: 'both', p1: pending[0], p2: pending[1],
      });
      pending = []; adding = false;
      refreshRows(); draw();
    } else {
      draw();
    }
  };
  $('#line-add').onclick = () => { adding = true; pending = []; $('#line-count').textContent = 'Pulsa dos puntos en la imagen'; };
  $('#line-clear').onclick = () => { lines.length = 0; pending = []; adding = false; refreshRows(); draw(); };
  $('#line-cancel').onclick = closeModal;
  $('#line-save').onclick = async () => {
    try {
      await api(`/cameras/${cam.id}`, {
        method: 'PATCH',
        body: { detection: { analytics: {
          enabled: base.enabled !== false,
          tracking_enabled: base.tracking_enabled !== false,
          line_crossing_enabled: base.line_crossing_enabled !== false,
          lines,
          max_track_age: base.max_track_age ?? 12,
          line_cross_cooldown: base.line_cross_cooldown ?? 4,
        } } },
      });
      toast('Líneas de cruce guardadas'); closeModal(); refresh(true);
    } catch (e) { toast(e.message || 'No se pudo guardar', 'err'); }
  };
  refreshRows();
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

  let summary = {};
  try { summary = await api('/events/summary'); }
  catch { /* backend antiguo: la vista de eventos sigue funcionando */ }
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
        ${ev.meta?.line_name ? `<span>✂ ${esc(ev.meta.line_name)} (${esc(ev.meta.direction || '')})</span>` : ''}
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
      ${ev?.meta?.line_name ? `<span class="muted">✂ ${esc(ev.meta.line_name)} · ${esc(ev.meta.direction || '')} · objeto ${esc(ev.meta.label || '')}</span>` : ''}
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

let _eventsBusy = false;
async function checkNewEvents() {
  if (_eventsBusy) return;
  _eventsBusy = true;
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
      if (alarmWanted(ev)) playAlarm(state.settings.notifications?.alarm_style || 'siren');
    }
    state.lastEventTs = ev.ts;
  } catch { /* silencioso */ }
  finally { _eventsBusy = false; }
}

/* ------------------------------------------------------------------ */
/* Informes semanales                                                  */
/* ------------------------------------------------------------------ */
async function renderReports() {
  if (!state.filters.repDate) state.filters.repDate = todayStr();
  let report = { period: { start: '—', end: '—' }, days: [], total: 0, unacknowledged: 0, line_crosses: { total: 0 }, by_camera: {}, by_label: {} };
  let stats = { cameras: [] };
  try {
    [report, stats] = await Promise.all([
      api('/analytics/report/weekly?date=' + encodeURIComponent(state.filters.repDate)),
      api('/analytics/stats'),
    ]);
  } catch { /* backend antiguo: mostramos la página con huecos en vez de romper la vista */ }
  const days = report.days || [];
  const dayMax = Math.max(1, ...(days.map(d => d.total || 0)));
  const statsCams = stats.cameras || [];

  $('#view').innerHTML = `
  <div class="panel">
    <div class="spread">
      <div class="row">
        <h3>📊 Informe semanal</h3>
        <input type="date" id="rep-date" value="${esc(state.filters.repDate)}">
        <button class="btn sm ghost" id="rep-refresh">⟳</button>
      </div>
      <span class="muted">${esc(report.period.start)} → ${esc(report.period.end)}</span>
    </div>
    <div class="grid kpis" style="margin-top:12px">
      <div class="kpi"><b>${report.total}</b><span>eventos</span></div>
      <div class="kpi"><b>${report.unacknowledged}</b><span>sin revisar</span></div>
      <div class="kpi"><b>${(report.line_crosses || {}).total || 0}</b><span>cruce de líneas</span></div>
      <div class="kpi"><b>${(Object.keys(report.by_camera || {})).length}</b><span>cámaras activas</span></div>
    </div>
  </div>

  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">
    <div class="panel">
      <h3>Por día</h3>
      <div class="rep-bars">
        ${days.map(d => `
          <div class="rep-bar">
            <span class="muted">${esc(d.date.slice(5))}</span>
            <div class="bar" style="width:${Math.max(4, (d.total / dayMax) * 100)}%"><i></i></div>
            <b>${d.total}</b>${d.line_crosses ? `<span class="cross">✂ ${d.line_crosses}</span>` : ''}
          </div>`).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>Por cámara</h3>
      <table><tr><th>Cámara</th><th>Eventos</th></tr>
        ${Object.entries(report.by_camera || {}).sort((a,b)=>b[1]-a[1]).map(([name,c]) => `<tr><td>${esc(name)}</td><td><b>${c}</b></td></tr>`).join('')}
      </table>
      <h3>Por tipo</h3>
      <div class="tags">${Object.entries(report.by_label || {}).sort((a,b)=>b[1]-a[1]).map(([l,c]) =>
        `<span class="tag ${esc(l)}">${esc(l)} · ${c}</span>`).join('')}</div>
    </div>
    <div class="panel">
      <h3>✂ Cruces de línea</h3>
      ${((report.line_crosses || {}).by_line && Object.keys((report.line_crosses || {}).by_line).length)
        ? Object.entries((report.line_crosses || {}).by_line).map(([name, objs]) => `
          <div style="margin-bottom:8px"><b>${esc(name)}</b>
            <div class="tags" style="margin-top:4px">${Object.entries(objs).map(([k,v]) =>
              `<span class="tag">${esc(k)} · ${v}</span>`).join('')}</div>
          </div>`).join('')
        : '<p class="muted">Sin cruces esta semana. Activa IA y dibuja líneas en Ajustes de cámara.</p>'}
      <div class="divider"></div>
      <h3>Analítica en vivo</h3>
      <table><tr><th>Cámara</th><th>IA</th><th>Líneas</th><th>Objetos</th></tr>
        ${statsCams.map(c => `<tr>
          <td>${esc(c.name)}</td>
          <td>${c.ai_enabled ? '✅' : '—'}</td>
          <td>${c.lines}</td>
          <td>${c.tracks ?? 0}</td></tr>`).join('')}
      </table>
    </div>
  </div>`;

  $('#rep-refresh').onclick = () => renderReports();
  $('#rep-date').onchange = e => { state.filters.repDate = e.target.value; renderReports(); };
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
  let cal = { days: [] };
  try { cal = await api('/recordings/calendar?days=31' + (f.recCamera ? `&camera_id=${f.recCamera}` : '')); }
  catch { /* backend antiguo: la vista de grabaciones sigue funcionando */ }
  const st = data.storage || {};
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
        <span class="muted">${data.total} ficheros · ${fmtBytes(((st.recordings || {}).bytes || 0) + ((st.clips || {}).bytes || 0))} · libre ${fmtBytes((st.disk || {}).free || 0)}</span>
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
    try {
      const tl = await api(`/recordings/timeline?date=${encodeURIComponent(day)}${f.recCamera ? `&camera_id=${f.recCamera}` : ''}`);
      content.innerHTML = timelinePanel(tl, day);
      wireTimeline();
    } catch {
      content.innerHTML = `<div class="list">${state.recordings.length ? state.recordings.map(recItem).join('') : '<div class="empty"><span class="big">📼</span>No hay grabaciones para este filtro</div>'}</div>`;
      $$('[data-rec]').forEach(el => el.onclick = () => videoModal(el.dataset.rec, el.dataset.name));
    }
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
  const canAdmin = !state.auth.enabled || state.auth.user?.role === 'admin';
  let sec = { auth_enabled: false, users: [], api_tokens: [], remote: {} };
  let pushSt = { available: false, enabled: false, public_key: '', subscriptions: 0, hint: '' };
  if (canAdmin) {
    // En paralelo (antes era secuencial y la pestaña "Ajustes" tardaba el doble).
    const [secR, pushR] = await Promise.all([
      api('/settings/auth/status').catch(() => null),
      api('/push/status').catch(() => null),
    ]);
    if (secR) sec = secR;
    if (pushR) pushSt = pushR;
  }
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
      <h4>🔊 Alarma sonora</h4>
      <label class="checkline"><input type="checkbox" id="alarm-on" ${s.notifications?.alarm_enabled !== false ? 'checked' : ''}> Sonar cuando llega un evento nuevo</label>
      <div class="form-grid">
        <div class="field"><label>Volumen</label><input type="number" min="0" max="1" step="0.05" id="alarm-vol" value="${s.notifications?.alarm_volume ?? 0.65}"></div>
        <div class="field"><label>Sonido</label>
          <select id="alarm-style">
            <option value="siren" ${(s.notifications?.alarm_style || 'siren') === 'siren' ? 'selected' : ''}>Sirena</option>
            <option value="beep" ${(s.notifications?.alarm_style || 'siren') === 'beep' ? 'selected' : ''}>Bip-bip</option>
          </select></div>
      </div>
      <button class="btn sm" id="alarm-test">Probar sonido</button>

      <div class="divider"></div>
      <div id="push-panel">
        <h4>📱 Push real al móvil (Web Push)</h4>
        <div id="push-box" class="muted">Comprobando…</div>
        <div class="row" style="margin-top:8px">
          <button class="btn sm" id="push-setup">Activar claves</button>
          <button class="btn sm primary" id="push-subscribe">Suscribir este dispositivo</button>
          <button class="btn sm ghost" id="push-test">Enviar prueba</button>
        </div>
      </div>

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
      <label class="checkline"><input type="checkbox" id="dt-an" ${s.detection?.analytics?.enabled !== false ? 'checked' : ''}> Analítica IA por defecto (seguimiento + cruces)</label>
      <label class="checkline"><input type="checkbox" id="dt-an-track" ${s.detection?.analytics?.tracking_enabled !== false ? 'checked' : ''}> Seguimiento de objetos</label>
      <label class="checkline"><input type="checkbox" id="dt-an-cross" ${s.detection?.analytics?.line_crossing_enabled !== false ? 'checked' : ''}> Cruce de líneas</label>
      <div class="field"><label>Modelo</label><input id="dt-model" value="${esc(s.detection?.ai_model || 'yolov8n.pt')}"></div>
      <div class="field"><label>Clases de interés (separadas por coma)</label>
        <input id="dt-labels" value="${esc((s.detection?.ai_labels || []).join(','))}"></div>
      <div class="field"><label>Confianza mínima</label>
        <input type="number" min="0.05" max="0.95" step="0.05" id="dt-conf" value="${s.detection?.ai_confidence ?? 0.45}"></div>
      <button class="btn primary" id="dt-save" style="margin-top:8px">Guardar</button>
    </div>

    <div class="panel" id="sec-panel">
      <h3>👥 Usuarios, tokens y 2FA</h3>
      <div class="field"><label>Nombre de usuario</label><input id="au-user" placeholder="usuario"></div>
      <div class="field"><label>Nombre visible</label><input id="au-name" placeholder="Administrador"></div>
      <div class="field"><label>Rol</label>
        <select id="au-role"><option value="admin">Admin (puede todo)</option><option value="viewer">Sólo ver</option></select></div>
      <div class="field"><label>Contraseña (obligatoria al crear)</label><input type="password" id="au-pass" placeholder="min. 8 caracteres"></div>
      <div class="row"><button class="btn primary" id="au-save">Guardar usuario</button><span class="muted">Al guardar con el mismo nombre se actualiza.</span></div>
      <div class="divider"></div>
      <table>
        <tr><th>Usuario</th><th>Rol</th><th>2FA</th><th></th></tr>
        ${(sec.users || []).map(u => `<tr>
          <td><b>${esc(u.name || u.username)}</b><div class="muted">${esc(u.username)}</div></td>
          <td>${u.role === 'admin' ? 'Admin' : 'Visor'}</td>
          <td>${u.totp_enabled ? '✅' : '—'}</td>
          <td>
            <button class="btn sm" data-2fa="${esc(u.username)}" data-2fa-enabled="${u.totp_enabled ? '1' : '0'}">${u.totp_enabled ? 'Desactivar 2FA' : 'Activar 2FA'}</button>
            <button class="btn sm ghost" data-deluser="${esc(u.username)}">Eliminar</button>
          </td>
        </tr>`).join('')}
      </table>
      <div class="divider"></div>
      <h4>🔑 Tokens de API</h4>
      <div class="row">
        <input id="at-name" placeholder="Nombre del token (ej. homeassistant)" style="flex:1">
        <select id="at-role"><option value="admin">Admin</option><option value="viewer">Visor</option></select>
        <button class="btn" id="at-create">Crear</button>
      </div>
      <div id="at-list" class="muted" style="margin-top:6px">
        ${(sec.api_tokens || []).map(t => `<span class="badge">${esc(t.name)} · ${t.role} · ${esc(t.prefix)}… <button class="btn sm ghost" data-deltoken="${esc(t.name)}">🗑</button></span>`).join(' ')}
      </div>
      <div class="divider"></div>
      <h4>📱 Acceso remoto</h4>
      <div id="remote-box" class="muted">Comprobando red…</div>
      <div class="form-grid" style="margin-top:8px">
        <div class="field"><label>DDNS (opcional)</label><input id="remote-ddns" placeholder="midominio.duckdns.org"></div>
        <div class="field"><label>Certificado HTTPS</label><input id="remote-cert" placeholder="C:\certs\vigia.crt"></div>
        <div class="field"><label>Clave HTTPS</label><input id="remote-key" placeholder="C:\certs\vigia.key"></div>
      </div>
      <div class="row" style="margin-top:8px"><button class="btn" id="remote-save">Guardar acceso remoto</button><span class="muted">HTTPS se aplica al reiniciar Vigía.</span></div>
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
        <button class="btn primary" id="diag-open">🩺 Diagnóstico y errores</button>
        <button class="btn" id="sys-export">Exportar configuración</button>
        <button class="btn ghost" id="sys-reload">Recargar del disco</button>
      </div>
      <div class="divider"></div>
      <h3>💣 Reinicio de fábrica</h3>
      <p class="muted">Borra cámaras, usuarios, tokens, notificaciones y todos los ajustes. La carpeta de datos no se borra.</p>
      <div class="row">
        <button class="btn danger" id="sys-reset">Restablecer ajustes</button>
        <button class="btn danger" id="sys-reset-all">Borrar ajustes y grabaciones</button>
      </div>
      <p class="muted" style="margin-top:12px">Versión de interfaz: <b>${UI_VERSION}</b> · backend: ${esc(info.version || '?')}</p>
    </div>
  </div>`;

  // Viewer: no puede administrar usuarios, tokens ni push.
  const secPanel = $('#sec-panel');
  if (secPanel && !canAdmin) secPanel.remove();
  const pushPanel = $('#push-panel');
  if (pushPanel && !canAdmin) pushPanel.remove();
  if (!canAdmin) {
    ['#sys-reset', '#sys-reset-all'].forEach(sel => { const b = $(sel); if (b) b.remove(); });
  }

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
        alarm_enabled: $('#alarm-on').checked,
        alarm_volume: +$('#alarm-vol').value,
        alarm_style: $('#alarm-style').value,
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

  // --- alarma sonora y push ---
  $('#alarm-test').onclick = () => playAlarm($('#alarm-style').value);
  (() => {
    const box = $('#push-box');
    if (!box) return;
    const setPushBox = () => {
      box.innerHTML = pushSt.available
        ? `${pushSt.enabled ? '✅' : '—'} activado · ${pushSt.subscriptions} dispositivo(s).<br><span class="muted">${esc(pushSt.hint || '')}</span>`
        : `<span style="color:var(--warn,#ffb454)">⚠ pywebpush no instalado.</span>`;
    };
    setPushBox();
    $('#push-setup').onclick = async () => {
      try {
        const r = await api('/push/setup', { method: 'POST', body: {} });
        pushSt = { ...pushSt, enabled: true, public_key: r.public_key };
        setPushBox();
        toast('Push activado. Suscribe este dispositivo.');
        if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
          const p = await Notification.requestPermission();
          if (p !== 'granted') toast('Permiso de notificaciones denegado', 'warn');
        }
        state.push.status = pushSt;
        const okSub = await subscribePush();
        if (okSub) { const d = await api('/push/status'); pushSt = d; setPushBox(); toast('Dispositivo suscrito al push'); }
      } catch (e) { toast(e.message || 'No se pudo activar push', 'err'); }
    };
    $('#push-subscribe').onclick = async () => {
      try {
        if (typeof Notification === 'undefined') { toast('Este navegador no soporta notificaciones', 'warn'); return; }
        if (Notification.permission !== 'granted') {
          const p = await Notification.requestPermission();
          if (p !== 'granted') { toast('Permiso denegado', 'warn'); return; }
        }
        if (!pushSt.enabled || !pushSt.public_key) {
          const r = await api('/push/setup', { method: 'POST', body: {} });
          pushSt = { ...pushSt, enabled: true, public_key: r.public_key };
        }
        state.push.status = pushSt;
        const ok = await subscribePush();
        if (!ok) { toast('No se pudo suscribir. Usa HTTPS o localhost para Web Push.', 'err'); return; }
        const d = await api('/push/status');
        pushSt = d; setPushBox();
        toast('Dispositivo suscrito. Recibirás las alertas aunque la pestaña esté cerrada.');
      } catch (e) { toast(e.message || 'No se pudo suscribir', 'err'); }
    };
    $('#push-test').onclick = async () => {
      try {
        const r = await api('/push/test', { method: 'POST', body: {} });
        toast(r.sent ? `Push enviado a ${r.sent} dispositivo(s)` : (r.skipped ? 'Sin dispositivos suscritos' : 'Push no enviado'));
      } catch (e) { toast(e.message || 'No se pudo probar push', 'err'); }
    };
  })();

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
        analytics: {
          enabled: $('#dt-an').checked,
          tracking_enabled: $('#dt-an-track').checked,
          line_crossing_enabled: $('#dt-an-cross').checked,
          lines: (s.detection?.analytics?.lines || []).map(l => ({ ...l })),
          max_track_age: s.detection?.analytics?.max_track_age ?? 12,
          line_cross_cooldown: s.detection?.analytics?.line_cross_cooldown ?? 4,
        },
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

  // --- usuarios / tokens / acceso remoto ---
  $('#au-save').onclick = async () => {
    const username = $('#au-user').value.trim();
    if (!username) return toast('Indica un nombre de usuario', 'warn');
    try {
      const r = await api('/settings/auth/users', {
        method: 'POST',
        body: { username, name: $('#au-name').value.trim(), role: $('#au-role').value, password: $('#au-pass').value },
      });
      toast(r.exists ? 'Usuario actualizado' : 'Usuario creado');
      $('#au-pass').value = '';
      refresh(true);
    } catch (e) { toast(e.message || 'No se pudo guardar', 'err'); }
  };
  $('#at-create').onclick = async () => {
    const name = $('#at-name').value.trim();
    if (!name) return toast('Pon un nombre al token', 'warn');
    try {
      const r = await api('/settings/auth/tokens', {
        method: 'POST',
        body: { name, role: $('#at-role').value },
      });
      toast('Token creado. Guarda esta clave ahora: ' + r.token);
      $('#at-name').value = '';
      refresh(true);
    } catch (e) { toast(e.message || 'No se pudo crear', 'err'); }
  };
  document.querySelectorAll('[data-2fa]').forEach(btn => btn.onclick = async () => {
    const username = btn.getAttribute('data-2fa');
    const enabled = btn.getAttribute('data-2fa-enabled') === '1';
    try {
      if (enabled) {
        if (!confirm(`¿Desactivar el segundo factor para ${username}?`)) return;
        await api('/settings/auth/users', { method: 'POST', body: { username, totp_enabled: false, totp_secret: '' } });
        toast('2FA desactivado'); refresh(true);
      } else {
        const r = await api('/settings/auth/2fa/new', { method: 'POST', body: { username } });
        openModal('Activar 2FA', `
          <p>1) Añade esta clave a Google Authenticator / Authy / Aegis:</p>
          <div class="kbd" style="display:block;padding:10px;margin:8px 0;word-break:break-all">${esc(r.secret)}</div>
          <p>2) Introduce un código de la app para comprobar que funciona:</p>
          <div class="field"><label>Código de verificación</label><input id="2fa-verify" inputmode="numeric" maxlength="6" placeholder="000000"></div>
          <p class="hint">Cada 30 segundos cambia. Ponlo con normalidad si aún no lo has añadido.</p>
          <div class="row" style="justify-content:flex-end;gap:8px">
            <button class="btn ghost" data-close>Cerrar</button>
            <button class="btn primary" id="2fa-enable">Activar</button>
          </div>`);
        $('#modal-body').addEventListener('click', e => {
          if (e.target.id === 'modal-close' || e.target.hasAttribute('data-close')) closeModal();
        });
        $('#2fa-enable').onclick = async () => {
          const code = $('#2fa-verify').value.trim();
          if (!code) return toast('Introduce el código de la app', 'warn');
          const ok = await api('/settings/auth/2fa/verify', { method: 'POST', body: { username, code, secret: r.secret } });
          if (!ok.ok) return toast('Código incorrecto; prueba a esperar al siguiente cambio', 'err');
          await api('/settings/auth/users', { method: 'POST', body: { username, totp_enabled: true, totp_secret: r.secret } });
          toast('2FA activado'); closeModal(); refresh(true);
        };
      }
    } catch (e) { toast(e.message || 'No se pudo configurar 2FA', 'err'); }
  });
  document.querySelectorAll('[data-deluser]').forEach(btn => btn.onclick = async () => {
    const username = btn.getAttribute('data-deluser');
    if (!confirm(`¿Eliminar al usuario ${username}?`)) return;
    try {
      await api(`/settings/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      toast('Usuario eliminado'); refresh(true);
    } catch (e) { toast(e.message || 'No se pudo eliminar', 'err'); }
  });
  document.querySelectorAll('[data-deltoken]').forEach(btn => btn.onclick = async () => {
    const name = btn.getAttribute('data-deltoken');
    if (!confirm(`¿Eliminar el token ${name}?`)) return;
    try {
      await api(`/settings/auth/tokens/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast('Token eliminado'); refresh(true);
    } catch (e) { toast(e.message || 'No se pudo eliminar', 'err'); }
  });
  $('#remote-save').onclick = async () => {
    try {
      await api('/settings/general', {
        method: 'PATCH',
        body: { remote: {
          https_enabled: !!(sec.remote && sec.remote.https_enabled) || false,
          certfile: $('#remote-cert').value.trim(),
          keyfile: $('#remote-key').value.trim(),
          ddns: $('#remote-ddns').value.trim(),
        } },
      });
      toast('Acceso remoto guardado'); refresh(true);
    } catch (e) { toast(e.message || 'No se pudo guardar', 'err'); }
  };
  (async () => {
    try {
      const remote = await api('/system/remote');
      if (!$('#remote-box')) return; // el usuario ya cambió de pestaña
      if ($('#remote-cert')) $('#remote-cert').value = remote.certfile || '';
      if ($('#remote-key')) $('#remote-key').value = remote.keyfile || '';
      if ($('#remote-ddns')) $('#remote-ddns').value = remote.ddns || '';
      const list = [
        'IP local: ' + (remote.local_ip || '—'),
        'Puerto: ' + (remote.port || '—'),
        remote.https_enabled ? 'HTTPS: activado con ' + remote.certfile : 'HTTPS: desactivado',
        remote.tailscale ? 'Tailscale: ' + remote.tailscale : 'Tailscale: no detectado en este equipo',
        remote.wireguard ? 'WireGuard interfaces: ' + remote.wireguard : '',
        'DDNS: ' + (remote.ddns || '—'),
      ].filter(Boolean);
      $('#remote-box').innerHTML = '<b>' + esc(info.system_name || 'Vigía') + '</b><br>' + list.map(esc).join('<br>');
    } catch {
      const box = $('#remote-box');
      if (box) box.textContent = 'No se pudo consultar la red.';
    }
  })();

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

  $('#diag-open').onclick = () => showDiagnostics();
  $('#sys-export').onclick = async () => {
    const data = await api('/settings/export', { method: 'POST', body: {} });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vigia-config-${todayStr()}.json`;
    a.click();
  };
  $('#sys-reload').onclick = async () => { await api('/settings/reload', { method: 'POST', body: {} }); refresh(true); toast('Configuración recargada'); };
  $('#sys-reset').onclick = async () => {
    const ok = confirm('¿Restablecer TODO a los ajustes de fábrica? Se eliminarán cámaras, usuarios, tokens y notificaciones. Las grabaciones se conservarán.');
    if (!ok) return;
    if (!confirm('Esta acción no se puede deshacer. ¿Continuar?')) return;
    try {
      await api('/settings/factory-reset', { method: 'POST', body: { wipe_recordings: false } });
      toast('Reinicio de fábrica completado');
      await refresh(true);
      location.hash = '#/dashboard';
      route();
    } catch (e) { toast(e.message || 'No se pudo restablecer', 'err'); }
  };
  $('#sys-reset-all').onclick = async () => {
    const ok = confirm('¿Borrar TODOS los ajustes y TODAS las grabaciones/clips/instantáneas?');
    if (!ok) return;
    if (!confirm('Esta acción es irreversible. ¿Continuar?')) return;
    try {
      await api('/settings/factory-reset', { method: 'POST', body: { wipe_recordings: true } });
      toast('Reinicio de fábrica + datos borrados');
      await refresh(true);
      location.hash = '#/dashboard';
      route();
    } catch (e) { toast(e.message || 'No se pudo restablecer', 'err'); }
  };
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
        <option value="dvrip">iCSee/XMEye multi-lente por DVRIP (puerto 34567)</option>
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
          <button class="btn sm" id="w-dis-dvrip">Buscar (DVRIP)</button>
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
      <div class="field w-dvrip" style="display:none"><label>Host / IP DVRIP</label>
        <input id="w-dv-host" placeholder="192.168.0.108"></div>
      <div class="field w-dvrip" style="display:none"><label>Puerto NetIP</label>
        <input type="number" id="w-dv-port" value="34567"></div>
      <div class="field w-dvrip" style="display:none"><label>Canal (lente)</label>
        <input type="number" id="w-dv-channel" value="0" min="0"></div>
      <div class="field w-dvrip" style="display:none"><label>Flujo</label>
        <select id="w-dv-stream"><option value="main" selected>Principal</option><option value="sub">Secundario</option></select></div>
      <div class="field w-dvrip" style="display:none"><label>Códec</label>
        <select id="w-dv-codec"><option value="auto" selected>Auto (H.264)</option><option value="h265">H.265</option></select></div>
      <div class="field w-dvrip" style="display:none"><label>Usuario</label><input id="w-dv-user"></div>
      <div class="field w-dvrip" style="display:none"><label>Contraseña</label><input type="password" id="w-dv-pass"></div>
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
    $$('.w-dvrip').forEach(e => e.style.display = t === 'dvrip' ? '' : 'none');
    $$('.w-usb').forEach(e => e.style.display = t === 'usb' ? '' : 'none');
    $$('.w-file').forEach(e => e.style.display = t === 'file' ? '' : 'none');
    $('#w-discover-box').style.display = (t === 'rtsp' || t === 'dvrip') ? '' : 'none';
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

  // Busca una cámara ya existente que apunte al mismo dispositivo-canal.
  // Si existe, la actualizamos con las credenciales/configuración del asistente
  // en lugar de crear una copia (era la causa de decenas de cámaras muertas al
  // pulsar "Añadir" dos veces).
  function alreadyExists(payload) {
    return state.cameras.find(c => {
      // Sólo comparamos con cámaras de la MISMA vía: una cámara RTSP y una
      // DVRIP de la misma lente son entradas distintas y no deben bloquearse.
      if (payload.source_type === 'dvrip' && c.source_type === 'dvrip') {
        return (c.dvrip?.host || '') === (payload.dvrip?.host || '')
          && +c.dvrip?.channel === +(payload.dvrip?.channel ?? -1);
      }
      if (payload.source_type === 'rtsp' && c.source_type === 'rtsp') {
        const a = icseeInfo(payload.url || '');
        const b = icseeInfo(c.url || '');
        if (a.host && a.host === b.host) {
          const ca = /[?&_]channel=(\d+)/i.exec(payload.url || '');
          const cb = /[?&_]channel=(\d+)/i.exec(c.url || '');
          if (ca && cb && ca[1] === cb[1]) return c;
        }
        if ((payload.url || '') === (c.url || '')) return c;
      }
      return false;
    });
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
    let updated = 0;
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
      const dup = alreadyExists(payload);
      if (dup) {
        const label = g.mosaic ? 'Mosaico' : 'Lente ' + g.channel;
        try {
          await api(`/cameras/${dup.id}`, { method: 'PATCH', body: payload });
          updated++;
          toast(`${label}: ya existía, credenciales y configuración actualizadas`, 'warn');
        } catch (e) { toast(`${label}: ${e.message}`, 'err'); }
        continue;
      }
      try {
        await api('/cameras', { method: 'POST', body: payload });
        added++;
      } catch (e) { toast(`${g.mosaic ? 'Mosaico' : 'Lente ' + g.channel}: ${e.message}`, 'err'); }
    }
    if (added || updated) {
      toast(`${added} cámaras añadidas${updated ? `, ${updated} actualizadas` : ''}${icsee ? ' (ONVIF/PTZ configurado)' : ''}`);
      closeModal();
      await refresh(true);
      location.hash = '#/dashboard';
    }
  }

  // Añade una cámara por cada lente detectada por DVRIP/NetIP (puerto 34567).
  // Es la vía fiable para iCSee 3-en-1 donde RTSP channel=1/2/3 NO cambia de
  // lente. Cada lente se crea como cámara independiente con source dvrip.
  async function addAllDvrip(host, user, pass, lenses, onvifInfo = null) {
    const base = $('#w-name').value.trim() || 'Cámara';
    const grp = $('#w-group').value.trim() || 'General';
    const ov = onvifInfo || {};
    const ptzProfile = (ov.profiles || []).find(p => p.has_ptz) || (ov.profiles || [])[0];
    const ptzIndex = ptzProfile ? (ov.profiles || []).indexOf(ptzProfile) : (ov.has_ptz ? 0 : -1);
    let added = 0;
    let updated = 0;
    for (const lens of lenses || []) {
      const index = +lens.index || 0;
      const label = lens.label || `Lente ${index + 1}`;
      const profile = (ov.profiles || [])[index];
      const isPtz = (ov.profiles || []).length
        ? !!(profile?.has_ptz || (ptzProfile && index === ptzIndex))
        : (ov.has_ptz && index === ptzIndex);
      const payload = {
        name: `${base} · ${label}`,
        group: grp,
        source_type: 'dvrip',
        url: `dvrip://${host}:${ov.port || 34567}/channel=${index + 1}`,
        username: user || '',
        password: pass || '',
        dvrip: {
          enabled: true,
          host,
          port: +($('#w-dv-port').value || ov.port || 34567),
          channel: index,
          stream: 'main',
          codec: 'auto',
          title: label,
          ptz_enabled: isPtz,
        },
        recording: { mode: 'motion', quality: 'medium' },
      };
      if (ov.port || profile?.token) {
        payload.onvif = {
          enabled: isPtz,
          host,
          port: +ov.port || 8899,
          username: ov.username || user || '',
          password: ov.password ? pass || '' : '',
          profile_token: isPtz ? (profile?.token || ptzProfile?.token || '') : '',
          use_onvif_stream: false,
        };
      }
      const dup = alreadyExists(payload);
      if (dup) {
        try {
          await api(`/cameras/${dup.id}`, { method: 'PATCH', body: payload });
          updated++;
          toast(`${label}: ya existía, credenciales y configuración actualizadas`, 'warn');
        } catch (e) { toast(`${label}: ${e.message}`, 'err'); }
        continue;
      }
      try {
        await api('/cameras', { method: 'POST', body: payload });
        added++;
      } catch (e) { toast(`${label}: ${e.message}`, 'err'); }
    }
    if (added || updated) {
      toast(`${added} lente(s) añadidas vía DVRIP${updated ? `, ${updated} actualizadas` : ''}${ov.port ? ' · PTZ en lente giratoria.' : ''}`);
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
        const dvWarn = mode === 'dvrip' && data.available === false
          ? '<div class="item"><div class="grow"><div class="title" style="color:var(--warn,#ffb454)">DVRIP no disponible</div><div class="meta">Instala la librería <code>dvrip</code> (pip install dvrip) para enumerar lentes iCSee por el puerto 34567.</div></div></div>'
          : '';
        box.innerHTML = dvWarn + (data.devices || []).map(d => `
          <div class="item"><div class="grow">
              <div class="title">${esc(d.name || d.ip)}</div>
              <div class="meta"><span>${esc(d.ip)}</span>${(d.ports || []).length ? `<span>puertos ${esc((d.ports || []).join(','))}</span>` : ''}
              ${d.hardware ? `<span>${esc(d.hardware)}</span>` : ''}
              ${d.channels ? `<span>DVRIP · ${esc(d.channels)} canal(es)</span>` : ''}</div>
              ${(d.rtsp_candidates || []).map(u => `<div class="meta" style="margin-top:4px"><button class="btn sm" data-url="${esc(u)}">${esc(u)}</button></div>`).join('')}
            </div>
            <button class="btn sm" data-probe="${esc(d.ip)}">Sondear RTSP</button>
            <button class="btn sm primary" data-diag="${esc(d.ip)}">Lentes iCSee</button>
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
  $('#w-dis-dvrip').onclick = () => discover('dvrip');

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
        // El diagnóstico sondea puertos, RTSP, DVRIP y ONVIF; puede tardar
        // más que una petición normal. Le damos margen real para que no salte
        // el timeout de red de 15 s antes de que el backend termine.
        timeout: 90000,
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
      // DVRIP/NetIP (puerto 34567): la vía fiable para iCSee multi-lente cuando
      // RTSP no expone todas las lentes. Se muestran como Lente 1/2/3 y se pueden
      // añadir todas de golpe.
      const dv = r.dvrip;
      const dvUser = dv && dv.login_ok ? (dv.username || $('#w-dis-user').value || '') : '';
      const dvPass = dv && dv.login_ok ? (dv.password_present ? $('#w-dis-pass').value : '') : '';
      if (dv && dv.login_ok && dv.lenses && dv.lenses.length) {
        const ovInfo = r.onvif_profiles && r.onvif_profiles.profiles ? r.onvif_profiles : null;
        const hasPtz = !!(ovInfo && (ovInfo.has_ptz || ovInfo.profiles.some(p => p.has_ptz)));
        html += `<div class="item" style="border-left:3px solid var(--accent,#3ddc97)">
          <div class="grow">
            <div class="title">📷 iCSee multi-lente vía DVRIP/NetIP: ${dv.channels} lente(s)</div>
            <div class="meta">Puerto 34567 · ${esc(dv.device?.hardware || '')} ${esc(dv.device?.software || '')} · ${hasPtz ? 'una lente con PTZ.' : 'PTZ vía ONVIF no detectado.'}</div>
          </div>
          <button class="btn sm primary" id="w-add-dvrip">➕ Añadir los ${dv.lenses.length}</button>
        </div>`;
        html += dv.lenses.map(l => `<div class="item"><div class="grow">
          <div class="title" style="font-size:12px">${esc(l.label)}${l.recording ? ' · grabando' : ''}${(ovInfo && (ovInfo.profiles[+l.index]?.has_ptz)) ? '<span style="color:var(--accent,#3ddc97)"> · PTZ</span>' : ''}</div>
          <div class="meta" style="font-size:11px">Canal DVRIP ${+l.index} · ${l.bitrate_kbps} kbit/s</div>
        </div>
        <button class="btn sm" data-dvrip-use="${esc(l.index)}">Usar</button></div>`).join('');
      }

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
      const addDv = $('#w-add-dvrip', box);
      if (addDv) {
        const dv = r.dvrip;
        addDv.onclick = () => addAllDvrip(
          ip, dvUser, dvPass, dv.lenses,
          r.onvif_profiles && r.onvif_profiles.profiles ? { ...r.onvif_profiles, password: !!r.onvif_profiles.password } : null
        );
      }
      $$('[data-dvrip-use]', box).forEach(b => {
        b.onclick = () => {
          const idx = +b.dataset.dvripUse;
          const lens = (r.dvrip?.lenses || []).find(l => +l.index === idx) || { index: idx, label: `Lente ${idx + 1}` };
          $('#w-type').value = 'dvrip';
          syncType();
          $('#w-dv-host').value = ip;
          $('#w-dv-port').value = 34567;
          $('#w-dv-channel').value = idx;
          $('#w-dv-stream').value = 'main';
          $('#w-dv-codec').value = 'auto';
          $('#w-dv-user').value = dvUser;
          $('#w-dv-pass').value = dvPass;
          $('#w-name').value = $('#w-name').value.trim() ? $('#w-name').value.trim() + ' · ' + lens.label : lens.label;
          const ovP = (r.onvif_profiles?.profiles || [])[idx];
          const ovHasPtz = !!(ovP?.has_ptz || (r.onvif_profiles?.has_ptz && idx === 0));
          if (r.onvif_profiles && (ovP || r.onvif_profiles.has_ptz)) {
            $('#w-onvif').checked = ovHasPtz;
            $('#w-onvif-box').style.display = ovHasPtz ? '' : 'none';
            $('#w-ov-host').value = ip;
            $('#w-ov-port').value = r.onvif_profiles?.port || 8899;
            $('#w-ov-user').value = r.onvif_profiles?.username || dvUser;
            $('#w-ov-pass').value = r.onvif_profiles?.password ? dvPass : '';
            $('#w-ov-token').value = ovHasPtz ? (ovP?.token || r.onvif_profiles?.ptz_profile_token || '') : '';
          }
          toast(`Lente ${idx + 1} puesta en el formulario (DVRIP)`);
        };
      });

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
    let dvripCfg = null;

    if (t === 'dvrip') {
      const host = $('#w-dv-host').value.trim();
      const port = +$('#w-dv-port').value || 34567;
      const channel = +$('#w-dv-channel').value || 0;
      user = $('#w-dv-user').value;
      pass = $('#w-dv-pass').value;
      url = host ? `dvrip://${host}:${port}/channel=${channel + 1}` : '';
      dvripCfg = {
        enabled: !!host,
        host,
        port,
        channel,
        stream: $('#w-dv-stream').value,
        codec: $('#w-dv-codec').value,
        title: $('#w-name').value.trim(),
        ptz_enabled: !!$('#w-onvif').checked,
      };
    }

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
      username: t === 'rtsp' || t === 'dvrip' ? user : '',
      password: t === 'rtsp' || t === 'dvrip' ? pass : '',
      device_index: t === 'usb' ? +$('#w-index').value : 0,
      device_name: t === 'usb' ? $('#w-devname').value.trim() : '',
    };
    if (dvripCfg) payload.dvrip = dvripCfg;
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
  const isDvrip = cam.source_type === 'dvrip';
  const camDvrip = cam.dvrip || {};
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
          ${['rtsp', 'dvrip', 'usb', 'file', 'demo'].map(t => `<option value="${t}" ${cam.source_type === t ? 'selected' : ''}>${t.toUpperCase()}</option>`).join('')}
        </select></div>
      ${isRtsp ? `<div class="field"><label>URL principal</label><input id="c-url" value="${esc(cam.url || '')}"></div>
      <div class="field"><label>URL secundaria</label><input id="c-sub" value="${esc(cam.substream_url || '')}"></div>
      <div class="field"><label>Usuario</label><input id="c-user" value="${esc(cam.username || '')}"></div>
      <div class="field"><label>Contraseña</label><input type="password" id="c-pass" value="${esc(cam.password || '')}"></div>` : ''}
      ${isDvrip ? `<div class="field"><label>Host DVRIP</label><input id="c-dv-host" value="${esc(cam.dvrip?.host || '')}"></div>
      <div class="field"><label>Puerto</label><input type="number" id="c-dv-port" value="${cam.dvrip?.port || 34567}"></div>
      <div class="field"><label>Canal (lente)</label><input type="number" min="0" id="c-dv-channel" value="${cam.dvrip?.channel ?? 0}"></div>
      <div class="field"><label>Códec</label><select id="c-dv-codec">
        <option value="auto" ${(cam.dvrip?.codec || 'auto') === 'auto' ? 'selected' : ''}>Auto (H.264)</option>
        <option value="h265" ${cam.dvrip?.codec === 'h265' ? 'selected' : ''}>H.265</option>
      </select></div>
      <div class="field"><label>Usuario</label><input id="c-dv-user" value="${esc(cam.username || '')}"></div>
      <div class="field"><label>Contraseña</label><input type="password" id="c-dv-pass" value="${esc(cam.password || '')}"></div>
      <div class="field grid-span2"><span class="hint">Grabación: usa <b>sólo movimiento</b> o <b>inteligente (clips)</b> para esta fuente DVRIP, porque el flujo continuo por ffmpeg no se puede copiar directamente.</span></div>` : ''}
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
      <div class="field"><label>Líneas de cruce</label><button class="btn sm" id="c-lines">✂ Editar líneas</button></div>
      <label class="checkline"><input type="checkbox" id="c-an" ${det.analytics?.enabled !== false ? 'checked' : ''}> Analítica IA activa (seguimiento + cruce)</label>
      <label class="checkline"><input type="checkbox" id="c-an-track" ${det.analytics?.tracking_enabled !== false ? 'checked' : ''}> Seguimiento de objetos</label>
      <label class="checkline"><input type="checkbox" id="c-an-cross" ${det.analytics?.line_crossing_enabled !== false ? 'checked' : ''}> Cruce de líneas</label>
      <div class="field grid-span2"><span class="hint">Para cruces fiables activa también <b>IA (personas/vehículos)</b> y dibuja líneas sobre la imagen.</span></div>
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
      <label class="checkline"><input type="checkbox" id="c-alarm" ${alerts.alarm_enabled !== false ? 'checked' : ''}> Sonar alarma en pantalla</label>
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
  $('#c-lines').onclick = () => lineEditor(cam);
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
    if ($('#c-dv-host')) {
      const dvHost = $('#c-dv-host').value.trim();
      const dvPort = +$('#c-dv-port').value || 34567;
      const dvChannel = +$('#c-dv-channel').value || 0;
      user = $('#c-dv-user').value;
      pass = $('#c-dv-pass').value;
      payload.username = user;
      payload.password = pass;
      payload.url = dvHost ? `dvrip://${dvHost}:${dvPort}/channel=${dvChannel + 1}` : (cam.url || '');
      payload.dvrip = {
        enabled: !!dvHost,
        host: dvHost,
        port: dvPort,
        channel: dvChannel,
        stream: 'main',
        codec: $('#c-dv-codec').value,
        title: cam.dvrip?.title || '',
        ptz_enabled: !!camDvrip.ptz_enabled,
      };
    }
    if (isDvrip && !['motion', 'smart'].includes($('#c-rec-mode').value)) {
      // El flujo DVRIP no se puede copiar por ffmpeg: forzamos clips por evento.
      $('#c-rec-mode').value = 'motion';
    }
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
      analytics: {
        enabled: $('#c-an').checked,
        tracking_enabled: $('#c-an-track').checked,
        line_crossing_enabled: $('#c-an-cross').checked,
        lines: (det.analytics?.lines || []).map(l => ({ ...l })),
        max_track_age: det.analytics?.max_track_age ?? 12,
        line_cross_cooldown: det.analytics?.line_cross_cooldown ?? 4,
      },
    };
    payload.alerts = {
      enabled: $('#c-alerts').checked,
      alarm_enabled: $('#c-alarm').checked,
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
      try {
        await api(`/cameras/${id}?purge=true`, { method: 'DELETE' });
        toast('Cámara eliminada'); refresh(true);
      } catch (err) {
        toast(err.message || 'No se pudo eliminar la cámara', 'err');
      }
    });
}

document.addEventListener('DOMContentLoaded', boot);
