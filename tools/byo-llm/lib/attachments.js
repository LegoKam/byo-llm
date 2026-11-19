/*
 * Attachments: files the author adds as context for one request.
 *
 * Files are read in the browser and travel only inside the LLM request. They are never
 * uploaded to Experience Workspace and never stored.
 */

export const MAX_FILES = 5;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_TEXT_CHARS = 200000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

// Vision models downscale large images anyway; this keeps requests small and fast.
const IMAGE_MAX_EDGE = 1568;
const IMAGE_REENCODE_ABOVE = 700 * 1024;

const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml'];
const TEXT_TYPES = ['application/json', 'application/xml', 'application/xhtml+xml', 'application/yaml'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_EXTENSIONS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** What the file picker offers. */
export const ACCEPT = [
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
  ...Object.keys(IMAGE_EXTENSIONS).map((ext) => `.${ext}`),
  '.pdf',
].join(',');

const extensionOf = (name) => (String(name).includes('.') ? String(name).split('.').pop().toLowerCase() : '');

/**
 * @param {{ name: string, type: string }} file
 * @returns {'text'|'image'|'pdf'|'unsupported'}
 */
export function classify(file) {
  const type = (file.type || '').toLowerCase();
  const ext = extensionOf(file.name);
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (IMAGE_TYPES.includes(type) || (!type && IMAGE_EXTENSIONS[ext])) return 'image';
  if (type.startsWith('text/') || TEXT_TYPES.includes(type) || TEXT_EXTENSIONS.includes(ext)) return 'text';
  return 'unsupported';
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Checks a file before it is added.
 * @param {{ name: string, type: string, size: number }} file
 * @param {object} [state]
 * @param {number} [state.count] How many files are attached already.
 * @returns {{ kind: string }|{ error: string }}
 */
export function checkFile(file, { count = 0 } = {}) {
  if (count >= MAX_FILES) return { error: `You can attach up to ${MAX_FILES} files.` };
  const kind = classify(file);
  if (kind === 'unsupported') {
    return { error: `${file.name} can't be attached. Use text (txt, md, csv, json, html…), images (png, jpg, webp, gif) or PDF.` };
  }
  if (!file.size) return { error: `${file.name} is empty.` };
  const limit = { text: MAX_TEXT_BYTES, image: MAX_IMAGE_BYTES, pdf: MAX_PDF_BYTES }[kind];
  if (file.size > limit) {
    return { error: `${file.name} is too large (${formatBytes(file.size)}). The limit for this kind of file is ${formatBytes(limit)}.` };
  }
  return { kind };
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function toBase64(blob) {
  const url = await readAsDataUrl(blob);
  return url.slice(url.indexOf(',') + 1);
}

// Large photos and screenshots are scaled down and re-encoded as JPEG. If anything about
// that fails (an animated GIF, an exotic format), the original bytes are sent instead.
async function shrinkImage(file) {
  if (file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= IMAGE_REENCODE_ABOVE) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    // JPEG has no transparency: put transparent pixels on white, not black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/**
 * Reads a checked file into the form the prompt builder needs.
 * @param {File} file
 * @param {'text'|'image'|'pdf'} kind From checkFile.
 * @returns {Promise<object>} `{ kind, name, size, text, truncated }` for text,
 *  `{ kind, name, size, mediaType, data }` for images and PDFs. `size` is what will be sent.
 */
export async function readAttachment(file, kind) {
  if (kind === 'text') {
    const full = await file.text();
    const truncated = full.length > MAX_TEXT_CHARS;
    const text = truncated ? full.slice(0, MAX_TEXT_CHARS) : full;
    return { kind, name: file.name, size: text.length, text, truncated };
  }
  if (kind === 'image') {
    const blob = await shrinkImage(file);
    const mediaType = blob.type || file.type || IMAGE_EXTENSIONS[extensionOf(file.name)];
    return { kind, name: file.name, size: blob.size, mediaType, data: await toBase64(blob) };
  }
  return { kind, name: file.name, size: file.size, mediaType: 'application/pdf', data: await toBase64(file) };
}
