const $ = selector => document.querySelector(selector);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const drop = $('#drop');
const ui = {
  file: $('#file'), fit: $('#fit'), paddingX: $('#padding-x'), paddingXNumber: $('#padding-x-number'),
  paddingY: $('#padding-y'), paddingYNumber: $('#padding-y-number'), linkMargins: $('#link-margins'),
  crop: $('#crop'), guides: $('#guides'), center: $('#center'), lock: $('#lock'), layers: $('#layers'),
  text: $('#text'), family: $('#family'), size: $('#size'), sizeOut: $('#size-out'), y: $('#text-y'),
  yOut: $('#y-out'), color: $('#text-color'), bg: $('#bg'), hint: $('#hint'), status: $('#status')
};

const defaults = {
  images: [], selectedId: null, paddingX: 96, paddingY: 96, marginsLinked: false,
  crop: true, guides: true, text: '', family: 'Arial, sans-serif', size: 52, y: 86,
  color: '#151515', bg: '#ffffff', align: 'center'
};
let state = { ...defaults, images: [] };
let draggingCanvas = false;
let lastPoint;
let saveTimer;
let draggedLayerId = null;

const selectedLayer = () => state.images.find(layer => layer.id === state.selectedId) || null;
const clampMargin = value => Math.max(0, Math.min(360, Number(value) || 0));

function layerDimensions(layer) {
  const availableW = 1080 - state.paddingX * 2;
  const availableH = 1080 - state.paddingY * 2;
  const scale = layer.fit === 'cover'
    ? Math.max(availableW / layer.image.width, availableH / layer.image.height)
    : Math.min(availableW / layer.image.width, availableH / layer.image.height);
  const zoom = layer.zoom / 100;
  return { w: layer.image.width * scale * zoom, h: layer.image.height * scale * zoom };
}

function layerRect(layer) {
  const { w, h } = layerDimensions(layer);
  return { x: (1080 - w) / 2 + layer.dx, y: (1080 - h) / 2 + layer.dy, w, h };
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

function drawSelection(layer) {
  const rect = layerRect(layer);
  ctx.save();
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 8]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function draw({ includeGuides = true, includeSelection = true, save = true } = {}) {
  ctx.fillStyle = state.bg;
  ctx.fillRect(0, 0, 1080, 1080);
  state.images.filter(layer => layer.visible).forEach(layer => {
    const rect = layerRect(layer);
    if (state.crop) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(state.paddingX, state.paddingY, 1080 - state.paddingX * 2, 1080 - state.paddingY * 2);
      ctx.clip();
    }
    ctx.drawImage(layer.image, rect.x, rect.y, rect.w, rect.h);
    if (state.crop) ctx.restore();
  });
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
  if (includeSelection && selectedLayer()?.visible) drawSelection(selectedLayer());
  if (includeGuides && state.guides) drawGuide();
  if (save) scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  ui.status.textContent = '저장 중…';
  saveTimer = setTimeout(() => {
    const settings = { ...state, images: [], selectedId: null };
    localStorage.setItem('square-note', JSON.stringify(settings));
    ui.status.textContent = '설정 자동 저장';
  }, 250);
}

function read() {
  const layer = selectedLayer();
  if (layer) layer.fit = ui.fit.value;
  Object.assign(state, {
    crop: ui.crop.checked, guides: ui.guides.checked, text: ui.text.value,
    family: ui.family.value, size: +ui.size.value, y: +ui.y.value,
    color: ui.color.value, bg: ui.bg.value
  });
  ui.sizeOut.value = state.size;
  ui.yOut.value = state.y + '%';
  draw();
}

function syncMargins() {
  ui.paddingX.value = state.paddingX;
  ui.paddingXNumber.value = state.paddingX;
  ui.paddingY.value = state.paddingY;
  ui.paddingYNumber.value = state.paddingY;
  ui.linkMargins.classList.toggle('on', state.marginsLinked);
  ui.linkMargins.setAttribute('aria-pressed', String(state.marginsLinked));
}

function setMargin(axis, rawValue) {
  const value = clampMargin(rawValue);
  if (axis === 'x') state.paddingX = value;
  else state.paddingY = value;
  if (state.marginsLinked) state.paddingX = state.paddingY = value;
  syncMargins();
  draw();
}

function sync() {
  const layer = selectedLayer();
  ui.fit.value = layer?.fit || 'contain';
  ui.fit.disabled = !layer;
  ui.crop.checked = state.crop; ui.guides.checked = state.guides;
  ui.text.value = state.text; ui.family.value = state.family; ui.size.value = state.size;
  ui.y.value = state.y; ui.color.value = state.color; ui.bg.value = state.bg;
  ui.lock.disabled = !layer;
  ui.center.disabled = !layer;
  ui.lock.classList.toggle('on', Boolean(layer?.locked));
  ui.lock.textContent = layer?.locked ? '고정 해제' : '선택 사진 고정';
  ui.lock.setAttribute('aria-pressed', String(Boolean(layer?.locked)));
  canvas.classList.toggle('locked', Boolean(layer?.locked));
  document.querySelectorAll('[data-align]').forEach(button => button.classList.toggle('on', button.dataset.align === state.align));
  syncMargins();
  renderLayers();
  read();
}

function renderLayers() {
  if (!state.images.length) {
    ui.layers.innerHTML = '<p class="layers-empty">사진을 추가하면 여기에 쌓여요.</p>';
    ui.hint.classList.remove('hide');
    return;
  }
  ui.hint.classList.add('hide');
  ui.layers.innerHTML = [...state.images].reverse().map((layer, reverseIndex) => {
    const index = state.images.length - 1 - reverseIndex;
    return `<div class="layer-item${layer.id === state.selectedId ? ' selected' : ''}" draggable="true" data-id="${layer.id}">
      <span class="drag-handle" aria-hidden="true">⋮⋮</span><img src="${layer.src}" alt=""><button class="layer-name" type="button" data-action="select">${layer.name}</button>
      <button type="button" data-action="visible" aria-label="${layer.visible ? '사진 숨기기' : '사진 보이기'}">${layer.visible ? '◉' : '○'}</button>
      <button type="button" data-action="lock" aria-label="${layer.locked ? '고정 해제' : '사진 고정'}">${layer.locked ? '▣' : '□'}</button>
      <button type="button" data-action="up" aria-label="앞으로 보내기" ${index === state.images.length - 1 ? 'disabled' : ''}>↑</button>
      <button type="button" data-action="down" aria-label="뒤로 보내기" ${index === 0 ? 'disabled' : ''}>↓</button>
      <button type="button" data-action="delete" aria-label="사진 삭제">×</button>
    </div>`;
  }).join('');
}

function fileToLayer(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/') || file.size > 20971520) { reject(file.name); return; }
    const reader = new FileReader();
    reader.onload = event => {
      const image = new Image();
      image.onload = () => resolve({
        id: `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: file.name,
        image, src: event.target.result, fit: 'contain', zoom: 100, dx: 0, dy: 0,
        locked: false, visible: true
      });
      image.onerror = () => reject(file.name);
      image.src = event.target.result;
    };
    reader.onerror = () => reject(file.name);
    reader.readAsDataURL(file);
  });
}

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const results = await Promise.allSettled(files.map(fileToLayer));
  const added = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  state.images.push(...added);
  if (added.length) state.selectedId = added[added.length - 1].id;
  if (results.some(result => result.status === 'rejected')) alert('이미지 파일은 장당 20MB 이하로 선택해주세요.');
  ui.file.value = '';
  sync();
}

function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * 1080 / rect.width, y: (event.clientY - rect.top) * 1080 / rect.height };
}

function pickLayerAt(pointValue) {
  return [...state.images].reverse().find(layer => {
    if (!layer.visible) return false;
    const rect = layerRect(layer);
    return pointValue.x >= rect.x && pointValue.x <= rect.x + rect.w && pointValue.y >= rect.y && pointValue.y <= rect.y + rect.h;
  });
}

function moveLayer(id, delta) {
  const index = state.images.findIndex(layer => layer.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.images.length) return;
  const [layer] = state.images.splice(index, 1);
  state.images.splice(target, 0, layer);
}

canvas.addEventListener('pointerdown', event => {
  const hit = pickLayerAt(point(event));
  if (hit && hit.id !== state.selectedId) { state.selectedId = hit.id; sync(); }
  const layer = selectedLayer();
  if (!layer || layer.locked || !layer.visible) return;
  draggingCanvas = true; lastPoint = point(event); canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  const layer = selectedLayer();
  if (!draggingCanvas || !layer) return;
  const next = point(event); layer.dx += next.x - lastPoint.x; layer.dy += next.y - lastPoint.y; lastPoint = next; draw();
});
canvas.addEventListener('pointerup', () => { draggingCanvas = false; });
canvas.addEventListener('wheel', event => {
  const layer = selectedLayer();
  if (!layer || layer.locked || !layer.visible) return;
  event.preventDefault();
  layer.zoom = Math.max(20, Math.min(500, layer.zoom + (event.deltaY < 0 ? 5 : -5)));
  draw();
}, { passive: false });

ui.file.addEventListener('change', event => loadFiles(event.target.files));
drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('over'); loadFiles(event.dataTransfer.files); });
[ui.fit, ui.crop, ui.guides, ui.text, ui.family, ui.size, ui.y, ui.color, ui.bg].forEach(control => control.addEventListener('input', read));
ui.paddingX.addEventListener('input', event => setMargin('x', event.target.value));
ui.paddingXNumber.addEventListener('input', event => setMargin('x', event.target.value));
ui.paddingY.addEventListener('input', event => setMargin('y', event.target.value));
ui.paddingYNumber.addEventListener('input', event => setMargin('y', event.target.value));
ui.linkMargins.onclick = () => { state.marginsLinked = !state.marginsLinked; syncMargins(); scheduleSave(); };
document.querySelectorAll('[data-margin]').forEach(button => button.onclick = () => {
  state.paddingX = state.paddingY = +button.dataset.margin; syncMargins(); draw();
});
document.querySelectorAll('[data-align]').forEach(button => button.onclick = () => { state.align = button.dataset.align; sync(); });
ui.center.onclick = () => { const layer = selectedLayer(); if (!layer) return; layer.dx = 0; layer.dy = 0; draw(); };
ui.lock.onclick = () => { const layer = selectedLayer(); if (!layer) return; layer.locked = !layer.locked; sync(); };

ui.layers.addEventListener('click', event => {
  const button = event.target.closest('button');
  const item = event.target.closest('.layer-item');
  if (!button || !item) return;
  const layer = state.images.find(entry => entry.id === item.dataset.id);
  if (!layer) return;
  const action = button.dataset.action;
  if (action === 'select') state.selectedId = layer.id;
  if (action === 'visible') layer.visible = !layer.visible;
  if (action === 'lock') layer.locked = !layer.locked;
  if (action === 'up') moveLayer(layer.id, 1);
  if (action === 'down') moveLayer(layer.id, -1);
  if (action === 'delete') {
    state.images = state.images.filter(entry => entry.id !== layer.id);
    state.selectedId = state.images.at(-1)?.id || null;
  }
  sync();
});
ui.layers.addEventListener('dragstart', event => { draggedLayerId = event.target.closest('.layer-item')?.dataset.id || null; });
ui.layers.addEventListener('dragover', event => event.preventDefault());
ui.layers.addEventListener('drop', event => {
  event.preventDefault();
  const targetId = event.target.closest('.layer-item')?.dataset.id;
  if (!draggedLayerId || !targetId || draggedLayerId === targetId) return;
  const from = state.images.findIndex(layer => layer.id === draggedLayerId);
  const to = state.images.findIndex(layer => layer.id === targetId);
  const [layer] = state.images.splice(from, 1);
  state.images.splice(to, 0, layer);
  renderLayers(); draw();
});

document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  const layer = selectedLayer();
  if (!layer) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    state.images = state.images.filter(entry => entry.id !== layer.id);
    state.selectedId = state.images.at(-1)?.id || null;
    event.preventDefault(); sync(); return;
  }
  if (layer.locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const step = event.shiftKey ? 10 : 1;
  if (event.key === 'ArrowLeft') layer.dx -= step;
  if (event.key === 'ArrowRight') layer.dx += step;
  if (event.key === 'ArrowUp') layer.dy -= step;
  if (event.key === 'ArrowDown') layer.dy += step;
  event.preventDefault(); draw();
});

function download() {
  draw({ includeGuides: false, includeSelection: false, save: false });
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
  state = { ...defaults, images: [] };
  localStorage.removeItem('square-note'); sync();
};

try {
  const saved = JSON.parse(localStorage.getItem('square-note'));
  if (saved) {
    if (typeof saved.pad === 'number') { saved.paddingX = saved.pad; saved.paddingY = saved.pad; delete saved.pad; }
    state = { ...state, ...saved, images: [], selectedId: null };
  }
} catch {}
sync();
