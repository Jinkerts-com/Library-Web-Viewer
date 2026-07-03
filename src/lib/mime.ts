const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mov': 'video/quicktime',
    '.m4a': 'audio/mp4'
};

export function getMimeType(ext: string): string {
    return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}
