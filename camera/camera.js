import { renderTextCanvas } from './text.js';
import { loadShapeCatalog, normalizeShapeSearch, createShapeImage } from './shapes.js';
const CHARACTERS = [
  { id: 'nauru', name: 'ナウルくん', src: '../nauru_kun_outline.png' },
  { id: 'onlion', name: 'おんライオン', src: './assets/onlion.png' },
  { id: 'nauruchan', name: 'ナウルちゃん', src: './assets/nauruchan.png' },
  { id: 'fake-phosphate', name: '偽リン鉱石くん', src: './assets/fake-phosphate.png' },
  { id: 'phosphate', name: 'リン鉱石くん', src: './assets/phosphate.png' }
];
const $ = id => document.getElementById(id);
const stage = $('camera-stage');
const video = $('camera-video');
let backgroundImage = $('background-image');
const layers = {
  logo: { element: $('logo-layer'), x: .79, y: .87, size: .3, rotation: 0, flip: false }
};
const creditCanvas = $('credit-layer');
const CREDIT_TEXT = '© ナウル共和国政府観光局';
const MAX_CHARACTERS = 3;
const characters = [];
const texts = [];
const MAX_TEXTS = 3;
let nextTextId = 1;
let nextCharacterId = 1;
const state = { selected: null, mode: 'camera', backgroundUrl: null, backgroundType: 'image/jpeg', backgroundSequence: 0, overlaySequence: 0, overlayLoading: false, facing: 'environment', stream: null, opening: false, captureBusy: false, captureSequence: 0, shapeSequence: 0, shapeLoading: false, sequence: 0, blob: null, photoUrl: null, fileName: '' };
const pointers = new Map();
let gesture = null;
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const compactTools = matchMedia('(max-width: 1100px), (pointer: coarse)');
let openTool = null;
const toolTitles = { materials: '素材', text: '文字', placement: '配置・ロゴ' };
function renderToolPanel() {
  const compact = compactTools.matches;
  if (!compact) openTool = null;
  if (compact && openTool) document.body.dataset.toolOpen = openTool;
  else delete document.body.dataset.toolOpen;
  const panel = $('controls-panel');
  panel.inert = compact && !openTool;
  if (compact) panel.setAttribute('aria-hidden', String(!openTool));
  else panel.removeAttribute('aria-hidden');
  for (const section of panel.querySelectorAll('[data-tool-page]')) section.hidden = compact && section.dataset.toolPage !== openTool;
  for (const button of $('tool-launcher').querySelectorAll('button')) button.setAttribute('aria-expanded', String(compact && button.dataset.openTool === openTool));
  $('tool-sheet-title').textContent = toolTitles[openTool] || '写真の設定';
}
function closeTools(focusTarget = null) {
  const previous = openTool;
  openTool = null; renderToolPanel();
  if (compactTools.matches && focusTarget) focusTarget.focus({ preventScroll: true });
  else if (compactTools.matches && $('controls-panel').contains(document.activeElement)) {
    $('tool-launcher').querySelector(`[data-open-tool="${previous}"]`)?.focus({ preventScroll: true });
  }
}
for (const button of $('tool-launcher').querySelectorAll('button')) button.addEventListener('click', () => {
  if (openTool === button.dataset.openTool) { closeTools(button); return; }
  openTool = button.dataset.openTool; renderToolPanel(); $('close-tools').focus({ preventScroll: true });
});
$('close-tools').addEventListener('click', () => closeTools());
document.addEventListener('pointerdown', event => {
  if (openTool && !event.target.closest('#controls-panel, #tool-launcher, dialog')) closeTools();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && openTool && !document.querySelector('dialog[open]')) { event.preventDefault(); closeTools(); }
});
let sheetSwipe = null;
$('tool-sheet-head').addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return;
  sheetSwipe = { id: event.pointerId, y: event.clientY };
  $('tool-sheet-head').setPointerCapture(event.pointerId);
});
$('tool-sheet-head').addEventListener('pointerup', event => {
  if (sheetSwipe?.id === event.pointerId && event.clientY - sheetSwipe.y > 40) closeTools();
  sheetSwipe = null;
});
$('tool-sheet-head').addEventListener('pointercancel', () => { sheetSwipe = null; });
compactTools.addEventListener('change', renderToolPanel);
new ResizeObserver(() => document.body.style.setProperty('--tool-dock-height', `${$('tool-launcher').getBoundingClientRect().height}px`)).observe($('tool-launcher'));
renderToolPanel();


function status(message, error = false) {
  $('camera-status').textContent = message;
  $('camera-status').classList.toggle('error', error);
}
function renderLayers() {
  for (const [id, layer] of Object.entries(layers)) {
    Object.assign(layer.element.style, {
      left: `${layer.x * 100}%`, top: `${layer.y * 100}%`, width: `${layer.size * 100}%`,
      transform: `translate(-50%, -50%) rotate(${layer.rotation}deg) scaleX(${layer.flip ? -1 : 1})`
    });
    layer.element.classList.toggle('selected', state.selected === id);
  }
  layers.logo.element.hidden = !$('show-logo').checked;
  creditCanvas.hidden = !characters.some(id => layers[id].requiresCredit);
  video.classList.toggle('mirrored', state.facing === 'user' && $('mirror-selfie').checked);
}
function selectLayer(id) {
  if (id && !layers[id]) return;
  if (id === 'logo' && !$('show-logo').checked) return;
  if (state.selected !== id) clearGesture();
  state.selected = id;
  syncControls();
  renderLayers();
}
function syncControls() {
  $('select-logo').setAttribute('aria-pressed', String(state.selected === 'logo'));
  $('select-logo').disabled = !$('show-logo').checked;
  $('flip-layer').disabled = !state.selected;
  $('remove-character').disabled = !characters.includes(state.selected) && !texts.includes(state.selected);
  $('edit-text').hidden = !texts.includes(state.selected);
  $('selected-name').textContent = state.selected === 'logo' ? 'ロゴ' : layers[state.selected]?.element.alt || '素材を追加しよう';
  for (const button of document.querySelectorAll('#placed-characters button, #placed-texts button')) button.setAttribute('aria-pressed', String(button.dataset.layerId === state.selected));
}
function renderCharacters() {
  const list = $('character-list');
  list.replaceChildren();
  for (const character of CHARACTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'character-choice';
    button.dataset.characterId = character.id;
    button.setAttribute('aria-label', `${character.name}を追加`);
    const image = new Image();
    image.src = character.src;
    image.alt = '';
    const name = document.createElement('span');
    name.textContent = character.name;
    button.append(image, name);
    button.addEventListener('click', () => addCharacter(character));
    list.append(button);
  }
}
function renderPlacements() {
  const list = $('placed-characters');
  list.replaceChildren();
  characters.forEach((id, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'placed-choice';
    button.dataset.layerId = id;
    const name = `${index + 1} ${layers[id].element.alt}`;
    button.setAttribute('aria-label', `${name}を編集`);
    button.title = name;
    const image = new Image();
    image.src = layers[id].element.src;
    image.alt = '';
    const label = document.createElement('span');
    label.textContent = name;
    button.append(image, label);
    button.addEventListener('click', () => selectLayer(id));
    list.append(button);
  });
  for (let i = characters.length; i < MAX_CHARACTERS; i++) {
    const slot = document.createElement('span');
    slot.className = 'empty-slot';
    slot.textContent = '＋ 追加できます';
    list.append(slot);
  }
  const full = characters.length === MAX_CHARACTERS;
  $('character-count').textContent = `${characters.length} / 3枚`;
  $('character-list').querySelectorAll('button').forEach(button => { button.disabled = full; });
  $('add-overlay-image').disabled = full || state.overlayLoading;
  $('add-shape').disabled = full || state.shapeLoading;
  $('add-text').disabled = texts.length >= MAX_TEXTS;
  const textList = $('placed-texts'); textList.replaceChildren(); textList.hidden = !texts.length;
  for (const [index, id] of texts.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'placed-text-choice'; button.dataset.layerId = id;
    const name = `${index + 1} ${layers[id].text.content.replace(/\n/g, ' ')}`; button.textContent = `T ${name}`; button.title = name; button.setAttribute('aria-label', `文字${name}を選択`);
    button.addEventListener('click', () => { selectLayer(id); openTextEditor(id); }); textList.append(button);
  }
  syncControls();
}
function addCharacter(character, preparedImage = null, objectUrl = null) {
  if (characters.length >= MAX_CHARACTERS) return;
  const id = `character-${nextCharacterId++}`;
  const image = preparedImage || new Image();
  image.id = id;
  image.className = 'photo-layer character-layer';
  image.dataset.layerId = id;
  if (!preparedImage) image.src = character.src;
  image.alt = character.name;
  image.draggable = false;
  image.tabIndex = 0;
  image.title = 'ドラッグで移動・ホイールで拡大縮小・Shift＋ホイールで回転';
  // DOM order and export order stay identical, with the logo above every character.
  stage.insertBefore(image, texts.length ? layers[texts[0]].element : layers.logo.element);
  layers[id] = { element: image, objectUrl, requiresCredit: !preparedImage && CHARACTERS.includes(character), x: [.5, .22, .78][characters.length], y: .62, size: characters.length ? .3 : .38, rotation: 0, flip: false };
  characters.push(id);
  selectLayer(id);
  renderPlacements();
  if (openTool) closeTools(image);
  image.decode().catch(() => { if (layers[id]) status('画像を読み込めませんでした。削除して、もう一度追加してください。', true); });
}
function removeCharacter() {
  const id = state.selected;
  const items = characters.includes(id) ? characters : texts;
  if (!items.includes(id)) return;
  clearGesture();
  const index = items.indexOf(id);
  items.splice(index, 1);
  layers[id].element.remove();
  if (layers[id].objectUrl) URL.revokeObjectURL(layers[id].objectUrl);
  delete layers[id];
  selectLayer(items[Math.min(index, items.length - 1)] || characters[0] || texts[0] || ($('show-logo').checked ? 'logo' : null));
  renderPlacements();
}
function fitStage() {
  clearGesture();
  const shell = stage.parentElement;
  const ratio = state.mode === 'image' && backgroundImage.naturalWidth ? backgroundImage.naturalWidth / backgroundImage.naturalHeight : matchMedia('(orientation: portrait)').matches ? 3 / 4 : 4 / 3;
  const width = Math.max(0, Math.min(shell.clientWidth - 2, (shell.clientHeight - 2) * ratio));
  stage.style.width = `${width}px`;
  stage.style.height = `${width / ratio}px`;
  const credit = creditPlacement(ratio);
  Object.assign(creditCanvas.style, { left: `${credit.x * 100}%`, top: `${credit.y * 100}%`, width: `${credit.size * 100}%` });
  renderLayers();
}
function creditPlacement(ratio) {
  const creditRatio = creditCanvas.height / creditCanvas.width;
  const size = Math.min(.34, .4 / (ratio * creditRatio));
  return { size, x: .98 - size / 2, y: .98 - size * creditRatio * ratio / 2 };
}
function drawCredit(context, width, height) {
  if (!characters.some(id => layers[id].requiresCredit)) return;
  // Character copyright is independent of editable layers and DOM visibility.
  const credit = creditPlacement(width / height);
  const drawWidth = width * credit.size;
  const drawHeight = drawWidth * creditCanvas.height / creditCanvas.width;
  context.drawImage(creditCanvas, width * credit.x - drawWidth / 2, height * credit.y - drawHeight / 2, drawWidth, drawHeight);
}
function prepareCredit() {
  const canvas = creditCanvas;
  const context = canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8' });
  const font = '600 96px system-ui, -apple-system, "Segoe UI", sans-serif';
  context.font = font;
  canvas.width = Math.ceil(context.measureText(CREDIT_TEXT).width) + 40;
  canvas.height = 144;
  context.font = font;
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = 6;
  context.strokeStyle = '#000a';
  context.fillStyle = '#fff';
  context.strokeText(CREDIT_TEXT, 20, canvas.height / 2);
  context.fillText(CREDIT_TEXT, 20, canvas.height / 2);
}
function sourceReady() {
  return state.mode === 'image' ? !!backgroundImage.naturalWidth : !!state.stream && video.readyState >= 2;
}
function setSourceMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  backgroundImage.hidden = mode !== 'image';
  video.hidden = mode === 'image';
  $('use-camera').setAttribute('aria-pressed', String(mode === 'camera'));
  $('choose-background').setAttribute('aria-pressed', String(mode === 'image'));
  $('capture-photo').setAttribute('aria-label', mode === 'image' ? '合成画像を作る' : '写真を撮る');
  $('capture-photo').querySelector('span').textContent = mode === 'image' ? '完成' : '';
  $('switch-camera').textContent = mode === 'image' ? '画像を変更' : state.facing === 'user' ? '↻ アウトカメラへ' : '↻ インカメラへ';
  $('switch-camera').disabled = mode === 'camera' && !state.stream;
  $('mirror-selfie').disabled = mode === 'image';
  $('capture-photo').disabled = !sourceReady();
  $('camera-placeholder').hidden = mode === 'image' || !!state.stream;
  $('photo-title').textContent = mode === 'image' ? 'できあがり！' : '一緒に撮れた！';
  $('retake-photo').textContent = mode === 'image' ? '編集に戻る' : '撮り直す';
  fitStage();
}
async function readLocalImage(file) {
  const sourceUrl = URL.createObjectURL(file);
  const source = new Image();
  source.src = sourceUrl;
  let normalizedUrl = null;
  let canvas = null;
  try {
    await source.decode();
    if (!source.naturalWidth || !source.naturalHeight) throw new Error();
    // Never put the uploaded HDR source in the DOM. Freeze its decoded colours
    // in an SDR bitmap before display so HDR gain maps cannot dim other layers.
    const scale = Math.min(1, 4096 / Math.max(source.naturalWidth, source.naturalHeight));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    const context = canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8' });
    if (!context) throw new Error();
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    // PNG retains transparency and pixel values without carrying the source's
    // HDR gain map. Final JPEG/PNG output still follows the background file type.
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error();
    normalizedUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.src = normalizedUrl;
    await image.decode();
    return { image, url: normalizedUrl };
  } catch (_) {
    if (normalizedUrl) URL.revokeObjectURL(normalizedUrl);
    throw new Error('この画像を開けませんでした。JPEG・PNGなどの画像でお試しください。');
  } finally {
    URL.revokeObjectURL(sourceUrl);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
async function openBackground(file) {
  if (!file) return;
  const sequence = ++state.backgroundSequence;
  status('画像を開いています…');
  try {
    const { image, url } = await readLocalImage(file);
    if (sequence !== state.backgroundSequence) { URL.revokeObjectURL(url); return; }
    ++state.sequence;
    state.opening = false;
    $('start-camera').disabled = false;
    stopCamera();
    image.id = 'background-image';
    image.alt = '背景に選んだ画像';
    image.draggable = false;
    backgroundImage.replaceWith(image);
    backgroundImage = image;
    if (state.backgroundUrl) URL.revokeObjectURL(state.backgroundUrl);
    state.backgroundUrl = url;
    state.backgroundType = /^image\/jpe?g$/i.test(file.type) ? 'image/jpeg' : 'image/png';
    setSourceMode('image');
    status('画像を編集しています · ロゴや画像を置いて「完成」');
  } catch (error) { if (sequence === state.backgroundSequence) status(error.message, true); }
}
async function openOverlay(file) {
  if (!file || characters.length >= MAX_CHARACTERS) return;
  const sequence = ++state.overlaySequence;
  state.overlayLoading = true;
  renderPlacements();
  try {
    const { image, url } = await readLocalImage(file);
    if (sequence !== state.overlaySequence || characters.length >= MAX_CHARACTERS) { URL.revokeObjectURL(url); return; }
    addCharacter({ name: file.name.replace(/\.[^.]+$/, '') || '追加画像' }, image, url);
  } catch (error) { if (sequence === state.overlaySequence) status(error.message, true); }
  finally { if (sequence === state.overlaySequence) { state.overlayLoading = false; renderPlacements(); } }
}

function stopCamera() {
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  video.srcObject = null;
  $('capture-photo').disabled = !sourceReady();
  $('switch-camera').disabled = state.mode === 'camera';
}
function cameraError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'カメラが許可されていません。ブラウザのサイト設定でカメラを許可し、もう一度開いてください。';
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'このカメラを利用できません。別のカメラで試してください。';
  if (error.name === 'NotReadableError') return 'カメラを開けませんでした。他のカメラアプリを閉じてから試してください。';
  return 'カメラを開けませんでした。もう一度試してください。';
}
async function openCamera(facing = state.facing, exact = false) {
  if (state.opening) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status('カメラにはHTTPSでの接続が必要です。対応ブラウザで開いてください。', true);
    return;
  }
  state.opening = true;
  ++state.backgroundSequence;
  setSourceMode('camera');
  const sequence = ++state.sequence;
  $('start-camera').disabled = true;
  stopCamera();
  status('カメラを開いています…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { [exact ? 'exact' : 'ideal']: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    if (sequence !== state.sequence || document.visibilityState === 'hidden') { stream.getTracks().forEach(track => track.stop()); return; }
    state.stream = stream;
    state.facing = stream.getVideoTracks()[0].getSettings().facingMode || facing;
    video.srcObject = stream;
    await video.play();
    if (sequence !== state.sequence) return;
    $('camera-placeholder').hidden = true;
    $('capture-photo').disabled = false;
    $('switch-camera').disabled = false;
    $('switch-camera').textContent = state.facing === 'user' ? '↻ アウトカメラへ' : '↻ インカメラへ';
    renderLayers();
    status(`${state.facing === 'user' ? 'インカメラ' : 'アウトカメラ'}で撮影中 · 写真は端末内で処理します。`);
  } catch (error) {
    if (sequence !== state.sequence) return;
    stopCamera();
    $('camera-placeholder').hidden = false;
    status(cameraError(error), true);
  } finally {
    if (sequence === state.sequence) {
      state.opening = false;
      $('start-camera').disabled = false;
    }
  }
}

// One shared layer transform drives the preview and exported image. Normalize
// positions to the stage so resizing or device rotation doesn't alter placement.
function drawLayer(context, layer, width, height) {
  const image = layer.element;
  if (image.hidden) return;
  const isCanvas = image instanceof HTMLCanvasElement;
  if (!isCanvas && (!image.complete || !image.naturalWidth)) throw new Error('画像の読み込みを待って、もう一度撮影してください。');
  const drawWidth = width * layer.size;
  const drawHeight = drawWidth * (isCanvas ? image.height / image.width : image.naturalHeight / image.naturalWidth);
  context.save();
  context.translate(width * layer.x, height * layer.y);
  context.rotate(layer.rotation * Math.PI / 180);
  context.scale(layer.flip ? -1 : 1, 1);
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
}
async function capturePhoto() {
  if (!sourceReady() || state.captureBusy || (state.mode === 'camera' && !video.videoWidth)) return;
  const sequence = ++state.captureSequence;
  state.captureBusy = true;
  $('capture-photo').disabled = true;
  $('save-photo').disabled = true;
  $('share-photo').disabled = true;
  $('share-photo').hidden = true;
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
  state.photoUrl = null;
  state.blob = null;
  try {
    clearGesture();
    const bounds = stage.getBoundingClientRect();
    const fromImage = state.mode === 'image';
    const ratio = fromImage ? backgroundImage.naturalWidth / backgroundImage.naturalHeight : bounds.width / bounds.height;
    // Match object-fit: cover exactly. Never upscale beyond the camera frame.
    const source = fromImage ? backgroundImage : video;
    const fullWidth = fromImage ? backgroundImage.naturalWidth : video.videoWidth;
    const fullHeight = fromImage ? backgroundImage.naturalHeight : video.videoHeight;
    let sourceWidth = fullWidth;
    let sourceHeight = fullHeight;
    if (sourceWidth / sourceHeight > ratio) sourceWidth = sourceHeight * ratio;
    else sourceHeight = sourceWidth / ratio;
    const scale = Math.min(1, (fromImage ? 4096 : 2048) / Math.max(sourceWidth, sourceHeight));
    const canvas = $('captured-photo');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8' });
    context.save();
    if (!fromImage && state.facing === 'user' && $('mirror-selfie').checked) { context.translate(canvas.width, 0); context.scale(-1, 1); }
    context.drawImage(source, (fullWidth - sourceWidth) / 2, (fullHeight - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    context.restore();
    for (const id of [...characters, ...texts]) drawLayer(context, layers[id], canvas.width, canvas.height);
    drawLayer(context, layers.logo, canvas.width, canvas.height);
    drawCredit(context, canvas.width, canvas.height);
    // Paint the frozen, fully composed frame before any JPEG encoding. Keep
    // the same canvas for preview and save, so no decode or extra copy is needed.
    $('photo-status').textContent = `${canvas.width} × ${canvas.height}px・保存用の画像を準備しています…`;
    $('photo-dialog').showModal();
    video.pause();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (sequence !== state.captureSequence) return;
    const outputType = fromImage ? state.backgroundType : 'image/jpeg';
    const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('画像の作成に失敗しました。')), outputType, .94));
    if (sequence !== state.captureSequence) return;
    state.blob = blob;
    state.photoUrl = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    state.fileName = `dokodemo-nauru-${fromImage ? 'image' : 'camera'}-${stamp}.${outputType === 'image/png' ? 'png' : 'jpg'}`;
    $('photo-status').textContent = `${canvas.width} × ${canvas.height}px・iPhoneでは共有メニューから写真に保存できます。`;
    const file = new File([blob], state.fileName, { type: blob.type });
    $('share-photo').hidden = !(navigator.share && navigator.canShare?.({ files: [file] }));
    $('save-photo').disabled = false;
    $('share-photo').disabled = false;
  } catch (error) {
    if (sequence !== state.captureSequence) return;
    const message = error.message || '写真を作成できませんでした。もう一度試してください。';
    if ($('photo-dialog').open) $('photo-status').textContent = `${message}「撮り直す」で再度お試しください。`;
    else status(message, true);
  } finally {
    if (sequence === state.captureSequence) {
      state.captureBusy = false;
      $('capture-photo').disabled = !sourceReady();
    }
  }
}

function beginGesture() {
  const points = [...pointers.values()];
  if (!points.length || !layers[state.selected]) { gesture = null; return; }
  const layer = layers[state.selected];
  const a = points[0], b = points[1] || a;
  gesture = { id: state.selected, x: layer.x, y: layer.y, size: layer.size, rotation: layer.rotation, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, distance: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
}
function clearGesture() {
  for (const id of pointers.keys()) if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
  pointers.clear();
  gesture = null;
  Object.values(layers).forEach(layer => layer.element.classList.remove('dragging'));
}
stage.addEventListener('pointerdown', event => {
    if (event.target.closest('button') || pointers.size >= 2) return;
    const id = pointers.size ? state.selected : event.target.dataset.layerId;
    if (!id || !layers[id] || layers[id].element.hidden) return;
    event.preventDefault();
    selectLayer(id);
    const layer = layers[id];
    layer.element.focus({ preventScroll: true });
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    layer.element.classList.add('dragging');
    beginGesture();
});
stage.addEventListener('keydown', event => {
    const id = event.target.dataset.layerId;
    if (!layers[id]) return;
    const layer = layers[id];
    const movement = { ArrowLeft: [-.01, 0], ArrowRight: [.01, 0], ArrowUp: [0, -.01], ArrowDown: [0, .01] }[event.key];
    if (!movement && !['Delete', '+', '=', '-', '[', ']'].includes(event.key)) return;
    event.preventDefault();
    selectLayer(id);
    if (event.key === 'Delete') { removeCharacter(); return; }
    if (movement) {
      layer.x = clamp(layer.x + movement[0], 0, 1);
      layer.y = clamp(layer.y + movement[1], 0, 1);
    } else if (event.key === '[' || event.key === ']') {
      layer.rotation += event.key === '[' ? -5 : 5;
    } else layer.size = clamp(layer.size * (event.key === '-' ? .95 : 1.05), texts.includes(id) ? .001 : .08, 1.1);
    renderLayers();
});
stage.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId) || !gesture) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const points = [...pointers.values()];
  const a = points[0], b = points[1] || a;
  const bounds = stage.getBoundingClientRect();
  const layer = layers[gesture.id];
  layer.x = clamp(gesture.x + ((a.x + b.x) / 2 - gesture.cx) / bounds.width, 0, 1);
  layer.y = clamp(gesture.y + ((a.y + b.y) / 2 - gesture.cy) / bounds.height, 0, 1);
  if (points.length > 1 && gesture.distance > 0) {
    layer.size = clamp(gesture.size * Math.hypot(b.x - a.x, b.y - a.y) / gesture.distance, texts.includes(gesture.id) ? .001 : .08, 1.1);
    const degrees = gesture.rotation + (Math.atan2(b.y - a.y, b.x - a.x) - gesture.angle) * 180 / Math.PI;
    layer.rotation = ((degrees + 180) % 360 + 360) % 360 - 180;
  }
  renderLayers();
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(eventName, event => {
  pointers.delete(event.pointerId);
  if (!pointers.size) Object.values(layers).forEach(layer => layer.element.classList.remove('dragging'));
  beginGesture();
});
stage.addEventListener('wheel', event => {
  const id = event.target.dataset.layerId;
  if (!layers[id]) return;
  event.preventDefault();
  selectLayer(id);
  if (event.shiftKey) layers[id].rotation += event.deltaY > 0 ? 5 : -5;
  else layers[id].size = clamp(layers[id].size * (event.deltaY > 0 ? .95 : 1.05), texts.includes(id) ? .001 : .08, 1.1);
  renderLayers();
}, { passive: false });

const textEditor = { target: null, sequence: 0, bitmap: null, draft: null };
let lastTextStyle = { content: 'ナウルで記念写真', font: 'gothic', direction: 'horizontal', color: '#ffffff', effect: 'plain', outline: true, outlineColor: '#000000' };
function textDraft() {
  return { content: $('text-content').value, font: $('text-font').value, direction: $('text-direction').value, color: $('text-color').value, effect: $('text-effect').value, outline: $('text-outline').checked, outlineColor: $('text-outline-color').value };
}
async function previewText() {
  const sequence = ++textEditor.sequence;
  textEditor.bitmap = null; $('apply-text').disabled = true; $('text-outline-color').disabled = !$('text-outline').checked;
  $('text-message').textContent = '文字の仕上がりを準備しています…';
  const draft = textDraft();
  document.querySelector('.text-preview-box').dataset.direction = draft.direction;
  try {
    const bitmap = await renderTextCanvas(draft);
    if (sequence !== textEditor.sequence || !$('text-dialog').open) return;
    const canvas = $('text-preview'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8' }).drawImage(bitmap, 0, 0); textEditor.bitmap = bitmap; textEditor.draft = draft;
    $('apply-text').disabled = false; $('text-message').textContent = '文字を置いたあと、指で移動・2本で拡大／回転できます。';
  } catch (_) {
    if (sequence !== textEditor.sequence || !$('text-dialog').open) return;
    $('text-preview').getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8' }).clearRect(0, 0, $('text-preview').width, $('text-preview').height);
    $('text-message').textContent = !draft.content.trim() ? '文字を入力してください。' : draft.content.split('\n').length > 6 ? '改行は6行（縦書きは6列）までにしてください。' : draft.content.length > 120 ? '文字は120文字以内で入力してください。' : '文字を準備できませんでした。フォントを選び直して再度お試しください。';
  }
}
function openTextEditor(id = null) {
  if (!id && texts.length >= MAX_TEXTS) return;
  textEditor.target = id;
  const draft = id ? layers[id].text : lastTextStyle;
  $('text-direction').value = draft.direction || 'horizontal'; $('text-content').value = draft.content; $('text-font').value = draft.font; $('text-color').value = draft.color;
  $('text-effect').value = draft.effect; $('text-outline').checked = draft.outline; $('text-outline-color').value = draft.outlineColor;
  $('text-title').textContent = id ? '文字を編集' : '文字を追加'; $('apply-text').textContent = id ? '変更する' : '追加する';
  $('text-dialog').showModal(); previewText();
}
function fitTextSize(bitmap, maxWidth = .64, maxHeight = .4) {
  const rect = stage.getBoundingClientRect();
  const heightPerWidth = (rect.width / (rect.height || rect.width)) * bitmap.height / bitmap.width;
  return Math.min(maxWidth, maxHeight / heightPerWidth);
}
function applyText() {
  if (!textEditor.bitmap || $('apply-text').disabled) return;
  const draft = { ...textEditor.draft }, bitmap = textEditor.bitmap;
  let id = textEditor.target;
  if (id && !texts.includes(id)) return;
  if (!id) {
    if (texts.length >= MAX_TEXTS) return;
    id = `text-${nextTextId++}`;
    const canvas = document.createElement('canvas'); canvas.id = id; canvas.className = 'photo-layer text-layer'; canvas.dataset.layerId = id;
    canvas.setAttribute('role', 'img'); canvas.tabIndex = 0;
    layers[id] = { element: canvas, x: .5, y: [.22, .38, .54][texts.length], size: fitTextSize(bitmap), rotation: 0, flip: false };
    texts.push(id); stage.insertBefore(canvas, layers.logo.element);
  }
  const layer = layers[id];
  if (layer.text && layer.text.direction !== draft.direction) {
    // Keep the longest visible dimension when the writing direction changes.
    const oldAspect = layer.element.height / layer.element.width, newAspect = bitmap.height / bitmap.width;
    layer.size *= Math.max(1, oldAspect) / Math.max(1, newAspect);
    if (layer.x > 0 && layer.x < 1 && layer.y > 0 && layer.y < 1) {
      layer.size = Math.min(layer.size, fitTextSize(bitmap, 1.9 * Math.min(layer.x, 1 - layer.x), 1.9 * Math.min(layer.y, 1 - layer.y)));
    }
  }
  layer.text = draft;
  const canvas = layer.element; canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d', { colorSpace: 'srgb', colorType: 'unorm8' }).drawImage(bitmap, 0, 0);
  canvas.alt = draft.content; canvas.setAttribute('aria-label', draft.content); canvas.title = '指で移動・拡大／回転。「文字を編集」で内容と文字効果を変更';
  lastTextStyle = draft; selectLayer(id); renderPlacements(); $('text-dialog').close(); closeTools(canvas);
}
$('add-text').addEventListener('click', () => openTextEditor());
$('edit-text').addEventListener('click', () => openTextEditor(state.selected));
$('close-text').addEventListener('click', () => $('text-dialog').close());
$('text-dialog').addEventListener('close', () => { ++textEditor.sequence; textEditor.bitmap = null; });
for (const id of ['text-content', 'text-font', 'text-direction', 'text-color', 'text-effect', 'text-outline', 'text-outline-color']) $(id).addEventListener('input', previewText);
$('apply-text').addEventListener('click', applyText);

let shapeCatalog;
function renderShapeResults() {
  const list = $('shape-results'); list.replaceChildren();
  if (!shapeCatalog) return;
  const query = normalizeShapeSearch($('shape-search').value.trim());
  const terms = query.split(/\s+/).filter(Boolean);
  const pref = $('shape-prefecture').value;
  const targets = [...shapeCatalog.prefectures, ...shapeCatalog.municipalities].filter(target => {
    if (pref && target.prefCode !== pref) return false;
    if (!terms.length && !pref && target.kind !== 'prefecture') return false;
    const text = normalizeShapeSearch(`${target.name} ${target.kana || ''}`);
    return terms.every(term => text.includes(term));
  });
  targets.sort((a, b) => Number(normalizeShapeSearch(b.shortName || b.name) === query) - Number(normalizeShapeSearch(a.shortName || a.name) === query));
  for (const target of targets.slice(0, 80)) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = target.name;
    button.disabled = state.shapeLoading; button.addEventListener('click', () => addShape(target)); list.append(button);
  }
  $('shape-message').textContent = targets.length ? `${targets.length}件${targets.length > 80 ? ' · 先頭80件を表示。名前で絞り込めます。' : ''}` : '該当する図形がありません。別の名前で検索してください。';
}
async function openShapePicker() {
  if (characters.length >= MAX_CHARACTERS) return;
  $('shape-dialog').showModal(); $('shape-message').textContent = '図形の一覧を開いています…';
  try {
    shapeCatalog = await loadShapeCatalog();
    if (!$('shape-prefecture').options.length) {
      const all = new Option('全国から選ぶ', ''); $('shape-prefecture').add(all);
      for (const pref of shapeCatalog.prefectures) $('shape-prefecture').add(new Option(pref.name, pref.prefCode));
    }
    renderShapeResults();
  } catch (_) { $('shape-message').textContent = '一覧を開けませんでした。閉じて、もう一度お試しください。'; }
}
async function addShape(target) {
  if (state.shapeLoading || characters.length >= MAX_CHARACTERS) return;
  const sequence = ++state.shapeSequence; state.shapeLoading = true;
  $('add-nauru-shape').disabled = true; $('shape-results').querySelectorAll('button').forEach(button => button.disabled = true);
  $('shape-message').textContent = `${target.name}の図形を準備しています…`; renderPlacements();
  try {
    const { image, url } = await createShapeImage(target);
    if (sequence !== state.shapeSequence || characters.length >= MAX_CHARACTERS || !$('shape-dialog').open) { URL.revokeObjectURL(url); return; }
    addCharacter({ name: target.name }, image, url); $('shape-dialog').close(); closeTools(image);
    status(`${target.name}を追加しました。指で移動・2本で拡大／回転できます。`);
  } catch (_) {
    if (sequence === state.shapeSequence) $('shape-message').textContent = '図形を取得できませんでした。通信を確認して、もう一度選んでください。';
  } finally {
    if (sequence === state.shapeSequence) { state.shapeLoading = false; renderPlacements(); $('add-nauru-shape').disabled = false; $('shape-results').querySelectorAll('button').forEach(button => button.disabled = false); }
  }
}
$('add-shape').addEventListener('click', openShapePicker);
$('close-shapes').addEventListener('click', () => $('shape-dialog').close());
$('shape-dialog').addEventListener('close', () => { ++state.shapeSequence; state.shapeLoading = false; $('add-nauru-shape').disabled = false; renderPlacements(); renderShapeResults(); });
$('add-nauru-shape').addEventListener('click', () => addShape({ id: 'nauru-boundary', kind: 'nauru', name: 'ナウル共和国' }));
$('shape-search').addEventListener('input', renderShapeResults);
$('shape-prefecture').addEventListener('change', renderShapeResults);

$('start-camera').addEventListener('click', () => openCamera());
$('use-camera').addEventListener('click', () => openCamera());
$('choose-background').addEventListener('click', () => $('background-file').click());
$('add-overlay-image').addEventListener('click', () => $('overlay-file').click());
for (const [id, open] of [['background-file', openBackground], ['overlay-file', openOverlay]]) $(id).addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; open(file); });
$('switch-camera').addEventListener('click', () => state.mode === 'image' ? $('background-file').click() : openCamera(state.facing === 'user' ? 'environment' : 'user', true));
$('capture-photo').addEventListener('click', capturePhoto);
$('select-logo').addEventListener('click', () => { selectLayer('logo'); closeTools(layers.logo.element); });
$('remove-character').addEventListener('click', removeCharacter);
$('flip-layer').addEventListener('click', () => { if (state.selected) { layers[state.selected].flip = !layers[state.selected].flip; renderLayers(); } });
$('show-logo').addEventListener('change', () => {
  if (!$('show-logo').checked && state.selected === 'logo') selectLayer(characters[0] || texts[0] || null);
  if ($('show-logo').checked && !state.selected) selectLayer('logo');
  syncControls();
  renderLayers();
});
$('mirror-selfie').addEventListener('change', renderLayers);
$('reset-placement').addEventListener('click', () => {
  clearGesture();
  characters.forEach((id, index) => Object.assign(layers[id], { x: (index + 1) / (characters.length + 1), y: .62, size: characters.length === 1 ? .38 : .3, rotation: 0, flip: false }));
  texts.forEach((id, index) => Object.assign(layers[id], { x: .5, y: [.22, .38, .54][index], size: fitTextSize(layers[id].element), rotation: 0, flip: false }));
  Object.assign(layers.logo, { x: .79, y: .87, size: .3, rotation: 0, flip: false });
  syncControls(); fitStage();
});
for (const id of ['close-photo', 'retake-photo']) $(id).addEventListener('click', () => $('photo-dialog').close());
$('photo-dialog').addEventListener('close', () => {
  ++state.captureSequence;
  state.captureBusy = false;
  $('capture-photo').disabled = !sourceReady();
  if (state.stream && document.visibilityState === 'visible') video.play().catch(() => status('カメラを再開できませんでした。もう一度開いてください。', true));
});
$('save-photo').addEventListener('click', () => {
  if (!state.photoUrl) return;
  const link = document.createElement('a'); link.href = state.photoUrl; link.download = state.fileName;
  document.body.append(link); link.click(); link.remove();
  $('photo-status').textContent = '保存を開始しました。ダウンロードをご確認ください。';
});
$('share-photo').addEventListener('click', async () => {
  if (!state.blob) return;
  try {
    await navigator.share({ files: [new File([state.blob], state.fileName, { type: state.blob.type })], title: 'どこでもナウルで記念写真' });
  } catch (error) { if (error.name !== 'AbortError') $('photo-status').textContent = '共有できませんでした。「画像を保存」をお使いください。'; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    ++state.sequence; stopCamera(); clearGesture();
    state.opening = false;
    $('start-camera').disabled = false;
    if (state.mode === 'camera') {
      $('camera-placeholder').hidden = false;
      status('カメラを停止しました。「カメラを開く」で再開できます。');
    }
  }
});
window.addEventListener('pagehide', () => { ++state.sequence; stopCamera(); });
new ResizeObserver(fitStage).observe(stage.parentElement);
window.addEventListener('resize', fitStage);
prepareCredit(); renderCharacters(); addCharacter(CHARACTERS[0]); fitStage();
