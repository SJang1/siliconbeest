/**
 * Process Media Handler
 *
 * Reads a media attachment from R2, extracts basic metadata,
 * and updates the media_attachments row.
 */

import type { Env } from '../env';
import type { ProcessMediaMessage } from '../shared/types/queue';

// Known image MIME types and their magic bytes for dimension extraction
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/**
 * Extract width and height from PNG header bytes.
 * PNG IHDR chunk: bytes 16-19 = width, 20-23 = height (big-endian uint32).
 */
function parsePngDimensions(
  header: Uint8Array,
): { width: number; height: number } | null {
  // Minimum 24 bytes for PNG signature + IHDR
  if (header.length < 24) return null;
  // Check PNG signature
  if (
    header[0] !== 0x89 ||
    header[1] !== 0x50 ||
    header[2] !== 0x4e ||
    header[3] !== 0x47
  ) {
    return null;
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { width, height };
}

/**
 * Extract width and height from GIF header bytes.
 * GIF logical screen descriptor: bytes 6-7 = width, 8-9 = height (little-endian).
 */
function parseGifDimensions(
  header: Uint8Array,
): { width: number; height: number } | null {
  if (header.length < 10) return null;
  // Check GIF signature (GIF87a or GIF89a)
  const sig = String.fromCharCode(header[0], header[1], header[2]);
  if (sig !== 'GIF') return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  return { width, height };
}

/**
 * Extract width and height from JPEG.
 * Scans for SOF0/SOF2 markers to find dimensions.
 */
function parseJpegDimensions(
  data: Uint8Array,
): { width: number; height: number } | null {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < data.length - 1) {
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1];

    // SOF0 (0xC0) or SOF2 (0xC2) — baseline or progressive
    if (marker === 0xc0 || marker === 0xc2) {
      if (offset + 9 >= data.length) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      return { width, height };
    }

    // Skip this segment
    if (offset + 3 >= data.length) break;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const segmentLength = view.getUint16(offset + 2, false);
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * Try to extract dimensions from image data based on content type.
 */
function extractDimensions(
  data: Uint8Array,
  contentType: string,
): { width: number; height: number } | null {
  switch (contentType) {
    case 'image/png':
      return parsePngDimensions(data);
    case 'image/gif':
      return parseGifDimensions(data);
    case 'image/jpeg':
      return parseJpegDimensions(data);
    default:
      return null;
  }
}

export async function handleProcessMedia(
  msg: ProcessMediaMessage,
  env: Env,
): Promise<void> {
  const { mediaAttachmentId, accountId } = msg;

  // Load the media attachment metadata from D1
  const attachment = await env.DB.prepare(
    `SELECT id, file_path, content_type, file_size
     FROM media_attachments
     WHERE id = ? AND account_id = ?`,
  )
    .bind(mediaAttachmentId, accountId)
    .first<{
      id: string;
      file_path: string;
      content_type: string;
      file_size: number;
    }>();

  if (!attachment) {
    console.warn(`Media attachment ${mediaAttachmentId} not found, dropping message`);
    return;
  }

  const { file_path, content_type } = attachment;

  // Read the object from R2
  const object = await env.MEDIA_BUCKET.get(file_path);
  if (!object) {
    console.warn(`R2 object not found at ${file_path}, dropping message`);
    return;
  }

  let width: number | null = null;
  let height: number | null = null;

  // For images, extract dimensions from the file header
  if (IMAGE_TYPES.has(content_type)) {
    // Read enough bytes for header parsing (first 64KB should be plenty)
    const headerBytes = await readBytes(object.body, 65536);
    const dimensions = extractDimensions(headerBytes, content_type);
    if (dimensions) {
      width = dimensions.width;
      height = dimensions.height;
    }
  }

  // Update the media attachment row with extracted metadata
  await env.DB.prepare(
    `UPDATE media_attachments
     SET width = ?, height = ?, processed = 1, updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(width, height, mediaAttachmentId)
    .run();

  console.log(
    `Processed media ${mediaAttachmentId}: ${content_type}${width ? ` ${width}x${height}` : ''}`,
  );

  // TODO: Generate thumbnails using Cloudflare Image Transforms (cf.image)
  // This would involve creating resized variants and storing them back in R2.
  // See: https://developers.cloudflare.com/images/transform-images/transform-via-workers/
}

/**
 * Read up to `maxBytes` from a ReadableStream.
 */
async function readBytes(
  stream: ReadableStream,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (totalLength < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      totalLength += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  // Concat chunks
  const result = new Uint8Array(Math.min(totalLength, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const bytesToCopy = Math.min(chunk.length, maxBytes - offset);
    result.set(chunk.subarray(0, bytesToCopy), offset);
    offset += bytesToCopy;
    if (offset >= maxBytes) break;
  }
  return result;
}
