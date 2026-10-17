import { describe, expect, test } from 'bun:test';
import { readSavedPreferences } from '../src/lib/preferences';
import { focusOnMount, handleFacetEscape } from '../src/lib/facetPopoverFocus';

const throwingStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
};

describe('readSavedPreferences', () => {
    test('blocked storage yields defaults without throwing', () => {
        expect(readSavedPreferences(throwingStorage)).toEqual({ layout: null, zoom: null, recentColors: null });
        expect(readSavedPreferences(null)).toEqual({ layout: null, zoom: null, recentColors: null });
    });
    test('valid values are read; invalid ones ignored independently', () => {
        const data: Record<string, string> = { library_layout: 'grid', library_zoom: '120', library_recent_colors: '["#fff"]' };
        expect(readSavedPreferences({ getItem: k => data[k] ?? null })).toEqual({ layout: 'grid', zoom: 120, recentColors: ['#fff'] });
        const bad: Record<string, string> = { library_layout: 'weird', library_zoom: 'abc', library_recent_colors: '{nope' };
        expect(readSavedPreferences({ getItem: k => bad[k] ?? null })).toEqual({ layout: null, zoom: null, recentColors: null });
    });
});

describe('store initialization with blocked storage', () => {
    test('module evaluates, theme follows root class, toggle works when setItem throws', async () => {
        const g = globalThis as any;
        const saved = { window: g.window, document: g.document, localStorage: g.localStorage };
        const classes = new Set<string>(['dark']);
        const doc = {
            documentElement: {
                classList: {
                    contains: (c: string) => classes.has(c),
                    add: (c: string) => void classes.add(c),
                    remove: (c: string) => void classes.delete(c),
                },
            },
        };
        const win: any = {};
        Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
        let store: any;
        try {
            g.window = win;
            g.document = doc;
            g.localStorage = throwingStorage;
            store = await import(['../src/stores/libraryStore', 'blocked-storage'].join('?'));
            expect(store.themeStore.get()).toBe('dark');
            expect(store.layoutStore.get()).toBe('masonry');
            expect(store.zoomLevelStore.get()).toBe(200);
            store.toggleTheme();
            expect(store.themeStore.get()).toBe('light');
            expect(classes.has('dark')).toBe(false);
            store.setZoom(150);
            store.setLayout('grid');
            store.addRecentColor('#abcdef');
            expect(store.zoomLevelStore.get()).toBe(150);
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete g[k]; else g[k] = v;
            }
        }
    });
    test('light root class initializes light theme', async () => {
        const g = globalThis as any;
        const saved = { window: g.window, document: g.document };
        try {
            g.window = {};
            g.document = { documentElement: { classList: { contains: () => false } } };
            const store: any = await import(['../src/stores/libraryStore', 'blocked-storage-light'].join('?'));
            expect(store.themeStore.get()).toBe('light');
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete g[k]; else g[k] = v;
            }
        }
    });
});

describe('facet popover focus', () => {
    const mk = (log: string[], name: string) => ({ focus: () => void log.push(`focus:${name}`) });

    test('first open: panel focused once on mount, Escape closes and restores chip focus', () => {
        const log: string[] = [];
        const chip = mk(log, 'chip');
        const panel = mk(log, 'panel');
        const ref = focusOnMount();
        ref(panel); // panel mounts on first open
        expect(log).toEqual(['focus:panel']);
        const handled = handleFacetEscape('Escape', () => log.push('close'), chip);
        expect(handled).toBe(true);
        expect(log).toEqual(['focus:panel', 'close', 'focus:chip']);
        ref(null); // unmount
        ref(panel); // reopen focuses again
        expect(log.filter(l => l === 'focus:panel').length).toBe(2);
    });

    test('re-renders with the same node (filter/count/callback changes, ratio editing) never refocus', () => {
        const log: string[] = [];
        const panel = mk(log, 'panel');
        const ref = focusOnMount();
        ref(panel);
        for (let i = 0; i < 5; i++) ref(panel);
        expect(log).toEqual(['focus:panel']);
    });

    test('non-Escape keys are not handled', () => {
        const log: string[] = [];
        expect(handleFacetEscape('Enter', () => log.push('close'), mk(log, 'chip'))).toBe(false);
        expect(log).toEqual([]);
    });
});
