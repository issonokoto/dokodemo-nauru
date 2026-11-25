export const TEXT_FONTS = [
  { id: 'gothic', label: 'ゴシック', family: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: 'mincho', label: '明朝', family: 'NauruMincho', file: 'mincho.woff2' },
  { id: 'rounded', label: '丸ゴシック', family: 'NauruRounded', file: 'rounded.woff2' },
  { id: 'hand', label: '手書き風', family: 'NauruHand', file: 'hand.woff2' }
];
const fontLoads = new Map();
export async function renderTextCanvas(draft) {
  const content = String(draft.content).replace(/\r/g, '').replace(/\t/g, '    ');
  if (!content.trim()) throw new Error('文字を入力してください。');
  if (content.length > 120) throw new Error('文字は120文字以内で入力してください。');
  const lines = content.split('\n');
  if (lines.length > 6) throw new Error(draft.direction === 'vertical' ? '縦書きは6列までにしてください。' : '改行は6行までにしてください。');
  const font = TEXT_FONTS.find(option => option.id === draft.font) || TEXT_FONTS[0];
  if (font.file) {
    let loading = fontLoads.get(font.id);
    if (!loading) {
      const face = new FontFace(font.family, `url("${new URL('./fonts/' + font.file, import.meta.url)}")`);
      loading = face.load().then(loaded => { document.fonts.add(loaded); }).catch(error => { fontLoads.delete(font.id); throw error; });
      fontLoads.set(font.id, loading);
    }
    await loading;
  }
  const color = /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : '#ffffff';
  const outlineColor = /^#[0-9a-f]{6}$/i.test(draft.outlineColor) ? draft.outlineColor : '#000000';
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const fontString = size => `700 ${size}px ${font.family}`;
  context.font = fontString(96);
  let maxWidth = 1, ascent = 0, descent = 0;
  for (const line of lines) {
    const metrics = context.measureText(line || 'あ');
    maxWidth = Math.max(maxWidth, metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight);
    ascent = Math.max(ascent, metrics.actualBoundingBoxAscent || 86);
    descent = Math.max(descent, metrics.actualBoundingBoxDescent || 20);
  }
  const padding = 34, lineHeight = Math.max(128, ascent + descent + 10);
  const vertical = draft.direction === 'vertical';
  const forms = { '、': '︑', '。': '︒', ',': '︐', ':': '︓', ';': '︔', '!': '︕', '?': '︖', '（': '︵', '）': '︶', '(': '︵', ')': '︶', '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '【': '︻', '】': '︼', '〈': '︿', '〉': '﹀', '《': '︽', '》': '︾', '[': '﹇', ']': '﹈' };
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
  const columns = vertical ? lines.map(line => {
    const graphemes = segmenter ? [...segmenter.segment(line)].map(item => item.segment) : Array.from(line);
    const tokens = [];
    for (const text of graphemes) {
      if (/^[A-Za-z0-9]$/.test(text)) {
        if (tokens.at(-1)?.latin) tokens.at(-1).text += text;
        else tokens.push({ text, latin: true, rotate: true });
      } else tokens.push({ text: forms[text] || text, rotate: /^[ー─━—–…‥→←↔〜～]$/.test(text) });
    }
    return tokens.map(token => {
      const metric = context.measureText(token.text);
      return { ...token, advance: token.latin ? Math.max(60, metric.width + 12) : 112, baseline: token.rotate ? ((metric.actualBoundingBoxAscent || 86) - (metric.actualBoundingBoxDescent || 0)) / 2 : 43 };
    });
  }) : [];
  const rawWidth = vertical ? 96 + lineHeight * (columns.length - 1) + padding * 2 : maxWidth + padding * 2;
  const rawHeight = vertical ? Math.max(112, ...columns.map(column => column.reduce((sum, token) => sum + token.advance, 0))) + padding * 2 : ascent + descent + lineHeight * (lines.length - 1) + padding * 2;
  const scale = Math.min(1, 2048 / Math.max(rawWidth, rawHeight));
  canvas.width = Math.ceil(rawWidth * scale); canvas.height = Math.ceil(rawHeight * scale);
  context.scale(scale, scale); context.font = fontString(96); context.textAlign = 'center'; context.textBaseline = 'alphabetic'; context.lineJoin = 'round';
  const commands = [];
  if (vertical) {
    // Newlines start columns to the left; Japanese remains upright and Latin runs rotate together.
    columns.forEach((column, index) => {
      let y = padding;
      for (const token of column) { commands.push({ ...token, x: rawWidth - padding - 48 - index * lineHeight, y: y + token.advance / 2 }); y += token.advance; }
    });
  } else lines.forEach((text, index) => commands.push({ text, x: rawWidth / 2, y: padding + ascent + index * lineHeight, baseline: 0, rotate: false }));
  const draw = (offset = 0, fill = color, outline = false) => {
    context.fillStyle = fill;
    for (const command of commands) {
      context.save(); context.translate(command.x + offset, command.y + offset);
      if (command.rotate) context.rotate(Math.PI / 2);
      if (outline) { context.strokeStyle = outlineColor; context.lineWidth = 7; context.strokeText(command.text, 0, command.baseline); }
      context.fillText(command.text, 0, command.baseline); context.restore();
    }
  };
  if (draft.effect === 'label') {
    context.fillStyle = '#102d45e8';
    const r = 20, w = rawWidth - 12, h = rawHeight - 12;
    context.beginPath(); context.moveTo(6 + r, 6); context.lineTo(6 + w - r, 6); context.quadraticCurveTo(6 + w, 6, 6 + w, 6 + r); context.lineTo(6 + w, 6 + h - r); context.quadraticCurveTo(6 + w, 6 + h, 6 + w - r, 6 + h); context.lineTo(6 + r, 6 + h); context.quadraticCurveTo(6, 6 + h, 6, 6 + h - r); context.lineTo(6, 6 + r); context.quadraticCurveTo(6, 6, 6 + r, 6); context.closePath(); context.fill();
  }
  if (draft.effect === 'lift') {
    const value = parseInt(color.slice(1), 16), dark = '#' + [value >> 16, (value >> 8) & 255, value & 255].map(channel => Math.round(channel * .35).toString(16).padStart(2, '0')).join('');
    for (let offset = 7; offset >= 1; offset--) draw(offset, dark);
  }
  if (draft.effect === 'shadow') { context.shadowColor = '#000b'; context.shadowBlur = 8; context.shadowOffsetX = 7; context.shadowOffsetY = 7; }
  if (draft.effect === 'neon') { context.shadowColor = color; context.shadowBlur = 18; draw(); }
  let fill = color;
  if (draft.effect === 'gradient') { fill = context.createLinearGradient(0, padding, 0, rawHeight - padding); fill.addColorStop(0, color); fill.addColorStop(1, '#f5c542'); }
  draw(0, fill, draft.outline);
  return canvas;
}
