// Eagle stores folder iconColor and tag-group color as named colors
const EAGLE_COLORS: Record<string, string> = {
    red: '#EB5757',
    orange: '#F2994A',
    yellow: '#F2C94C',
    green: '#27AE60',
    aqua: '#56CCF2',
    blue: '#2F80ED',
    purple: '#9B51E0',
    pink: '#EF5DA8'
};

export function eagleColor(name?: string | null): string | null {
    if (!name) return null;
    if (name.startsWith('#')) return name;
    return EAGLE_COLORS[name.toLowerCase()] || null;
}
