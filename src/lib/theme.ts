export type Theme = 'light' | 'dark';

export const DEFAULT_THEME: Theme = 'dark';
export const THEME_STORAGE_KEY = 'theme';

/** Parse the VIEWER_THEME environment value (trimmed, case-insensitive). Invalid/missing -> dark. */
export function parseEnvTheme(value: string | null | undefined): Theme {
    if (typeof value !== 'string') return DEFAULT_THEME;
    const normalized = value.trim().toLowerCase();
    return normalized === 'light' ? 'light' : normalized === 'dark' ? 'dark' : DEFAULT_THEME;
}

/** Only exactly "light" or "dark" count as a saved preference. */
export function parseSavedTheme(value: string | null | undefined): Theme | null {
    return value === 'light' || value === 'dark' ? value : null;
}

/** Precedence: valid saved preference > normalized env > dark. */
export function resolveTheme(envValue: string | null | undefined, savedValue: string | null | undefined): Theme {
    return parseSavedTheme(savedValue) ?? parseEnvTheme(envValue);
}

/**
 * Inline head script run before body paint. Reads the server default from
 * <html data-default-theme>, lets a valid saved preference win, and toggles the
 * root `dark` class synchronously. Storage access is guarded (blocked storage -> server default).
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var d=document.documentElement,t=d.getAttribute('data-default-theme')==='light'?'light':'dark';try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');if(s==='light'||s==='dark')t=s;}catch(e){}if(t==='dark')d.classList.add('dark');else d.classList.remove('dark');})();`;
