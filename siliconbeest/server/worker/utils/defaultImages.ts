/**
 * Generate default avatar and header images as SVG, upload to R2.
 * Avatar: colored circle with user initial.
 * Header: gradient banner.
 */

// Deterministic color from username
function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

function hslToHex(hslStr: string): string {
  const match = hslStr.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!match) return '#6366f1';
  const h = parseInt(match[1]) / 360;
  const s = parseInt(match[2]) / 100;
  const l = parseInt(match[3]) / 100;

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function generateAvatarSvg(username: string): string {
  const color = hslToHex(hashColor(username));
  const initial = username.charAt(0).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <rect width="400" height="400" rx="200" fill="${color}"/>
  <text x="200" y="200" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="180" font-weight="700" fill="white">${initial}</text>
</svg>`;
}

function generateHeaderSvg(username: string): string {
  const color1 = hslToHex(hashColor(username));
  const hue2 = (Math.abs(hashCode(username)) + 60) % 360;
  const color2 = hslToHex(`hsl(${hue2}, 50%, 40%)`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${color1}"/>
      <stop offset="100%" stop-color="${color2}"/>
    </linearGradient>
  </defs>
  <rect width="1500" height="500" fill="url(#g)"/>
</svg>`;
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return hash;
}

/**
 * Generate and upload default avatar + header to R2.
 * Returns { avatarUrl, headerUrl }.
 */
export async function createDefaultImages(
  bucket: R2Bucket,
  domain: string,
  accountId: string,
  username: string,
): Promise<{ avatarUrl: string; headerUrl: string }> {
  const avatarSvg = generateAvatarSvg(username);
  const headerSvg = generateHeaderSvg(username);

  const avatarKey = `avatars/${accountId}_default.svg`;
  const headerKey = `headers/${accountId}_default.svg`;

  await Promise.all([
    bucket.put(avatarKey, avatarSvg, {
      httpMetadata: { contentType: 'image/svg+xml' },
    }),
    bucket.put(headerKey, headerSvg, {
      httpMetadata: { contentType: 'image/svg+xml' },
    }),
  ]);

  return {
    avatarUrl: `https://${domain}/media/${avatarKey}`,
    headerUrl: `https://${domain}/media/${headerKey}`,
  };
}
