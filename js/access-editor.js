const $ = selector => document.querySelector(selector);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const drop = $('#drop');
const ui = {
  file: $('#file'), fit: $('#fit'), paddingX: $('#padding-x'), paddingXOut: $('#padding-x-out'),
  paddingY: $('#padding-y'), paddingYOut: $('#padding-y-out'), zoom: $('#zoom'), zoomOut: $('#zoom-out'),
  crop: $('#crop'), guides: $('#guides'), center: $('#center'), lock: $('#lock'), text: $('#text'),
  family: $('#family'), size: $('#size'), sizeOut: $('#size-out'), y: $('#text-y'), yOut: $('#y-out'),
  color: $('#text-color'), bg: $('#bg'), hint: $('#hint'), status: $('#status')
};
const defaults = {
  image: null, fit: 'contain', paddingX: 96, paddingY: 96, zoom: 100, crop: true, guides: true,
  locked: false, text: '', family: 'Arial, sans-serif', size: 52, y: 86,
  color: '#151515', bg: '#ffffff', align: 'center', dx: 0, dy: 0
};
let state = { ...defaults };
let dragging = false;
let lastPoint;
let saveTimer;

function imageDimensions() {
  if (!state.image) return { w: 0, h: 0 };
  const availableW = 1080 - state.paddingX * 2;
  const availableH = 1080 - state.paddingY * 2;
  const scale = state.fit === 'cover'
    ? Math.max(availableW / state.image.width, availableH / state.image.height)
    : Math.min(availableW / state.image.width, availableH / state.image.height);
  const zoom = state.zoom / 100;
  return { w: state.image.width * scale * zoom, h: state.image.height * scale * zoom };
}

function wrap(text, maxWidth) {
  const lines = [];
  text.split('\n').forEach(paragraph => {
    if (!paragraph) { lines.push(''); return; }
    let line = '';
    [...paragraph].forEach(char => {
      if (ctx.measureText(line + char).width > maxWidth && line) { lines.push(line); line = char; }
      else line += char;
    });
    lines.push(line);
  });
  return lines;
}

function drawGuide() {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,101,66,.9)';
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 12]);
  ctx.strokeRect(state.paddingX, state.paddingY, 1080 - state.paddingX * 2, 1080 - state.paddingY * 2);
  ctx.restore();
}

function draw({ includeGuides = true, save = true } = {}) {
  ctx.fillStyle = state.bg;
  ctx.fillRect(0, 0, 1080, 1080);
  if (state.image) {
    const { w, h } = imageDimensions();
    if (state.crop) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(state.paddingX, state.paddingY, 1080 - state.paddingX * 2, 1080 - state.paddingY * 2);
      ctx.clip();
    }
    ctx.drawImage(state.image, (1080 - w) / 2 + state.dx, (1080 - h) / 2 + state.dy, w, h);
    if (state.crop) ctx.restore();
  }
  if (state.text.trim()) {
    ctx.font = `600 ${state.size}px ${state.family}`;
    ctx.fillStyle = state.color;
    ctx.textAlign = state.align;
    ctx.textBaseline = 'middle';
    const px = state.align === 'left' ? state.paddingX : state.align === 'right' ? 1080 - state.paddingX : 540;
    const lines = wrap(state.text, 1080 - state.paddingX * 2);
    const lineHeight = state.size * 1.28;
    const startY = 1080 * state.y / 100 - (lines.length - 1) * lineHeight / 2;
    lines.forEach((line, index) => ctx.fillText(line, px, startY + index * lineHeight));
  }
  if (includeGuides && state.guides) drawGuide();
  if (save) scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  ui.status.textContent = '저장 중…';
  saveTimer = setTimeout(() => {
    localStorage.setItem('square-note', JSON.stringify({ ...state, image: null }));
    ui.status.textContent = '설정 자동 저장';
  }, 250);
}

function read() {
  Object.assign(state, {
    fit: ui.fit.value, paddingX: +ui.paddingX.value, paddingY: +ui.paddingY.value,
    zoom: +ui.zoom.value, crop: ui.crop.checked, guides: ui.guides.checked,
    text: ui.text.value, family: ui.family.value, size: +ui.size.value, y: +ui.y.value,
    color: ui.color.value, bg: ui.bg.value
  });
  ui.paddingXOut.value = state.paddingX;
  ui.paddingYOut.value = state.paddingY;
  ui.zoomOut.value = state.zoom + '%';
  ui.sizeOut.value = state.size;
  ui.yOut.value = state.y + '%';
  draw();
}

function sync() {
  ui.fit.value = state.fit; ui.paddingX.value = state.paddingX; ui.paddingY.value = state.paddingY;
  ui.zoom.value = state.zoom; ui.crop.checked = state.crop; ui.guides.checked = state.guides;
  ui.text.value = state.text; ui.family.value = state.family; ui.size.value = state.size;
  ui.y.value = state.y; ui.color.value = state.color; ui.bg.value = state.bg;
  ui.lock.classList.toggle('on', state.locked);
  ui.lock.textContent = state.locked ? '고정 해제' : '사진 위치 고정';
  ui.lock.setAttribute('aria-pressed', String(state.locked));
  ui.zoom.disabled = state.locked;
  canvas.classList.toggle('locked', state.locked);
  document.querySelectorAll('[data-align]').forEach(button => button.classList.toggle('on', button.dataset.align === state.align));
  read();
}

function load(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 20971520) { alert('20MB 이하의 사진을 선택해주세요.'); return; }
  const reader = new FileReader();
  reader.onload = event => {
    const image = new Image();
    image.onload = () => {
      Object.assign(state, { image, dx: 0, dy: 0, zoom: 100 });
      ui.zoom.value = 100;
      ui.hint.classList.add('hide');
      draw();
    };
    image.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * 1080 / rect.width, y: (event.clientY - rect.top) * 1080 / rect.height };
}

canvas.addEventListener('pointerdown', event => {
  if (!state.image || state.locked) return;
  dragging = true; lastPoint = point(event); canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!dragging) return;
  const next = point(event); state.dx += next.x - lastPoint.x; state.dy += next.y - lastPoint.y; lastPoint = next; draw();
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('wheel', event => {
  if (!state.image || state.locked) return;
  event.preventDefault();
  state.zoom = Math.max(50, Math.min(250, state.zoom + (event.deltaY < 0 ? 5 : -5)));
  ui.zoom.value = state.zoom; read();
}, { passive: false });

ui.file.addEventListener('change', event => load(event.target.files[0]));
drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('over'); load(event.dataTransfer.files[0]); });
[ui.fit, ui.paddingX, ui.paddingY, ui.zoom, ui.crop, ui.guides, ui.text, ui.family, ui.size, ui.y, ui.color, ui.bg].forEach(control => control.addEventListener('input', read));
document.querySelectorAll('[data-align]').forEach(button => button.onclick = () => { state.align = button.dataset.align; sync(); });
ui.center.onclick = () => { state.dx = 0; state.dy = 0; draw(); };
ui.lock.onclick = () => { state.locked = !state.locked; sync(); };

function download() {
  draw({ includeGuides: false, save: false });
  const anchor = document.createElement('a');
  anchor.download = `square-note-${new Date().toISOString().slice(0, 10)}.png`;
  anchor.href = canvas.toDataURL('image/png');
  anchor.click();
  draw();
}

$('#download').onclick = download;
$('#mobile-download').onclick = download;
$('#reset').onclick = () => {
  if (!confirm('모두 초기화할까요?')) return;
  state = { ...defaults }; ui.file.value = ''; ui.hint.classList.remove('hide');
  localStorage.removeItem('square-note'); sync();
};

try {
  const saved = JSON.parse(localStorage.getItem('square-note'));
  if (saved) {
    if (typeof saved.pad === 'number') { saved.paddingX = saved.pad; saved.paddingY = saved.pad; delete saved.pad; }
    state = { ...state, ...saved, image: null };
  }
} catch {}
sync();
