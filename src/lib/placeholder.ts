export const PLACEHOLDER_SVG = `
<svg width="100%" height="100%" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#e0e0e0"/>
  <path d="M100 80 L120 120 L80 120 Z" fill="#9e9e9e"/>
  <rect x="70" y="130" width="60" height="60" rx="5" fill="#9e9e9e" opacity="0.5"/>
  <text x="50%" y="50%" dy="40" font-family="sans-serif" font-size="14" fill="#757575" dominant-baseline="middle" text-anchor="middle">No Preview</text>
</svg>`.trim();

export function getPlaceholderResponse() {
    return new Response(PLACEHOLDER_SVG, {
        status: 200,
        headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=3600"
        }
    });
}
