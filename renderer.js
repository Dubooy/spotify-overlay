const stage = document.getElementById('stage');
const island = document.getElementById('island');
const $$ = (sel) => [...island.querySelectorAll(sel)];

const arts = $$('.art');
const titles = $$('.title');
const artists = $$('.artist');
const eqBars = $$('.eq i');
const fills = $$('.fill');
const tracks = $$('.track');
const tEl = $$('.t-el');
const tRem = $$('.t-rem');
const ringFg = island.querySelector('.ring-fg');
const RING_LEN = 188.5;

let state = { active: false };
let receivedAt = 0;
let open = false;
let closeTimer = null;
let lastKey = '';
let lastSecond = -1;

// ---------- Utilidades ----------
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function currentPosition() {
  if (!state.active) return 0;
  let pos = state.position || 0;
  // Algunos reproductores no actualizan bien la hora: si es absurda, usamos la de llegada.
  const ref = (state.updated && Math.abs(receivedAt - state.updated) < 3600000) ? state.updated : receivedAt;
  if (state.playing) pos += Date.now() - ref;
  return Math.min(Math.max(0, pos), state.duration || 0);
}

// ---------- Estados visuales ----------
function applyVisibility() {
  const visible = !!(state.active && (state.title || state.artist));
  island.classList.toggle('is-hidden', !visible);
  island.classList.toggle('is-compact', visible && !open);
  island.classList.toggle('is-open', visible && open);
  island.classList.toggle('is-playing', !!state.playing);
  if (!visible) setOpen(false);
}

function setOpen(v) {
  if (open === v) return;
  open = v;
  applyVisibility();
  if (open) requestAnimationFrame(updateMarquees);
}

function bump() {
  island.classList.remove('bump');
  void island.offsetWidth;
  island.classList.add('bump');
}

// ---------- Texto con desplazamiento si no cabe ----------
function updateMarquees() {
  [...titles, ...artists].forEach((el) => {
    const span = el.firstElementChild;
    el.classList.remove('marquee');
    const over = span.scrollWidth - el.clientWidth;
    if (over > 4 && el.clientWidth > 0) {
      el.style.setProperty('--mq', `${-over - 12}px`);
      el.style.setProperty('--mq-time', `${Math.max(8, over / 18)}s`);
      el.classList.add('marquee');
    }
  });
}

// ---------- Datos que llegan de Windows ----------
function onState(s) {
  const prevKey = lastKey;
  state = s || { active: false };
  receivedAt = Date.now();
  const key = `${state.title}|${state.artist}`;
  if (key !== prevKey) {
    lastKey = key;
    titles.forEach((el) => { el.firstElementChild.textContent = state.title || ''; });
    artists.forEach((el) => { el.firstElementChild.textContent = state.artist || ''; });
    if (prevKey && state.active) bump();
    requestAnimationFrame(updateMarquees);
  }
  tracks.forEach((t) => t.classList.toggle('no-seek', !state.canSeek));
  applyVisibility();
}

function onArt(a) {
  const src = a && a.art;
  arts.forEach((img) => {
    img.classList.add('loading');
    setTimeout(() => {
      img.onload = () => img.classList.remove('loading');
      if (src) img.src = src; else { img.removeAttribute('src'); img.classList.remove('loading'); }
    }, 140);
  });
  if (src) extractAccent(src); else setAccent(null);
}

// Color vivo de la portada para el ecualizador y el anillo
function extractAccent(src) {
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 20;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 20, 20);
      const d = ctx.getImageData(0, 0, 20, 20).data;
      let best = null, score = -1;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 510;
        const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
        const sc = sat * (1 - Math.abs(l - .55) * 1.6);
        if (sc > score) { score = sc; best = [r, g, b]; }
      }
      setAccent(score > .15 ? best : null);
    } catch (e) { setAccent(null); }
  };
  img.src = src;
}

function setAccent(rgb) {
  const value = rgb ? `rgb(${rgb.map((v) => Math.round(Math.min(255, v * 1.15 + 20))).join(',')})` : 'var(--fg)';
  stage.style.setProperty('--accent', value);
}

// ---------- Controles ----------
function command(cmd) { window.isla.command(cmd); }

$$('.btn.play').forEach((b) => b.addEventListener('click', () => {
  state.playing = !state.playing;
  state.position = currentPosition();
  state.updated = Date.now();
  applyVisibility();
  command('toggle');
}));
$$('.btn.next').forEach((b) => b.addEventListener('click', () => command('next')));
$$('.btn.prev').forEach((b) => b.addEventListener('click', () => command('prev')));

tracks.forEach((track) => track.addEventListener('click', (e) => {
  if (!state.canSeek || !state.duration) return;
  const r = track.getBoundingClientRect();
  const ms = Math.round(((e.clientX - r.left) / r.width) * state.duration);
  state.position = ms;
  state.updated = Date.now();
  command(`seek ${ms}`);
}));

// ---------- Ratón: abrir al pasar por encima ----------
island.addEventListener('mouseenter', () => {
  window.isla.setInteractive(true);
  clearTimeout(closeTimer);
  setOpen(true);
});
island.addEventListener('mouseleave', () => {
  window.isla.setInteractive(false);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => setOpen(false), 320);
});
island.addEventListener('pointerdown', startAudioCapture, { once: true });

// ---------- Visualizador con audio real del sistema ----------
let analyser = null, freq = null;
async function startAudioCapture() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = .6;
    src.connect(analyser);
    freq = new Uint8Array(analyser.frequencyBinCount);
  } catch (e) { analyser = null; }
}

const BANDS = [[1, 3], [3, 8], [8, 18], [18, 40]];
const levels = [0, 0, 0, 0];
const gains = [.3, .3, .3, .3];

// ---------- Bucle de animación (60 fps) ----------
function frame(t) {
  requestAnimationFrame(frame);
  const playing = !!(state.active && state.playing);

  // Ecualizador
  if (analyser && playing) analyser.getByteFrequencyData(freq);
  for (let i = 0; i < 4; i++) {
    let target = .22;
    if (playing) {
      if (analyser) {
        const [a, b] = BANDS[i];
        let sum = 0;
        for (let k = a; k < b; k++) sum += freq[k];
        const v = sum / (b - a) / 255;
        gains[i] += ((v > gains[i] ? v : gains[i] * .995) - gains[i]) * .05;
        target = .2 + .8 * Math.min(1, v / Math.max(.08, gains[i] * 1.25));
      } else {
        target = .45 + .4 * Math.sin(t / (210 + i * 47) + i * 1.7) * Math.sin(t / (530 + i * 91));
      }
    }
    levels[i] += (target - levels[i]) * (target > levels[i] ? .45 : .14);
  }
  for (let i = 0; i < eqBars.length; i++) {
    eqBars[i].style.transform = `scaleY(${levels[i % 4].toFixed(3)})`;
  }

  // Progreso
  const dur = state.duration || 0;
  const pos = currentPosition();
  const frac = dur ? pos / dur : 0;
  fills.forEach((f) => { f.style.transform = `scaleX(${frac.toFixed(4)})`; });
  ringFg.style.strokeDashoffset = String(RING_LEN * (1 - frac));
  const sec = Math.floor(pos / 1000);
  if (sec !== lastSecond) {
    lastSecond = sec;
    tEl.forEach((el) => { el.textContent = fmt(pos); });
    tRem.forEach((el) => { el.textContent = '-' + fmt(dur - pos); });
  }
}

// ---------- Arranque ----------
function setMode(mode) {
  stage.classList.toggle('mode-island', mode !== 'bubble');
  stage.classList.toggle('mode-bubble', mode === 'bubble');
  setOpen(false);
}
function setSkin(skin) {
  stage.classList.toggle('skin-obsidiana', skin !== 'aero');
  stage.classList.toggle('skin-aero', skin === 'aero');
}

window.isla.onState(onState);
window.isla.onArt(onArt);
window.isla.onMode(setMode);
window.isla.onSkin(setSkin);
window.isla.init().then((cfg) => {
  setMode(cfg.mode);
  setSkin(cfg.skin);
  if (cfg.art) onArt(cfg.art);
  onState(cfg.state);
  requestAnimationFrame(frame);
});
