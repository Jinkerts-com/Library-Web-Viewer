import { describe, expect, test } from 'bun:test';
import {
    parseEnvTheme,
    parseSavedTheme,
    resolveTheme,
    THEME_BOOTSTRAP_SCRIPT,
} from '../src/lib/theme';

describe('parseEnvTheme', () => {
    test('unset/empty/whitespace-only -> dark', () => {
        expect(parseEnvTheme(undefined)).toBe('dark');
        expect(parseEnvTheme(null)).toBe('dark');
        expect(parseEnvTheme('')).toBe('dark');
        expect(parseEnvTheme('   ')).toBe('dark');
    });
    test('case-insensitive and trimmed', () => {
        expect(parseEnvTheme('LIGHT')).toBe('light');
        expect(parseEnvTheme('Light')).toBe('light');
        expect(parseEnvTheme('  light\t')).toBe('light');
        expect(parseEnvTheme('DARK')).toBe('dark');
        expect(parseEnvTheme(' dArK ')).toBe('dark');
    });
    test('invalid values -> dark', () => {
        for (const v of ['blue', 'auto', 'system', '1', 'light dark', 'lightx', '"light"']) {
            expect(parseEnvTheme(v)).toBe('dark');
        }
    });
});

describe('parseSavedTheme', () => {
    test('only exact light/dark are valid', () => {
        expect(parseSavedTheme('light')).toBe('light');
        expect(parseSavedTheme('dark')).toBe('dark');
        for (const v of [null, undefined, '', 'LIGHT', ' dark', 'auto', 'null']) {
            expect(parseSavedTheme(v as string | null | undefined)).toBeNull();
        }
    });
});

describe('resolveTheme precedence', () => {
    test('both unset/invalid -> dark', () => {
        expect(resolveTheme(undefined, null)).toBe('dark');
        expect(resolveTheme('nope', 'nope')).toBe('dark');
    });
    test('env beats built-in default', () => {
        expect(resolveTheme('LIGHT', null)).toBe('light');
        expect(resolveTheme(' light ', 'garbage')).toBe('light');
    });
    test('valid saved beats env', () => {
        expect(resolveTheme('LIGHT', 'dark')).toBe('dark');
        expect(resolveTheme('DARK', 'light')).toBe('light');
        expect(resolveTheme(undefined, 'light')).toBe('light');
    });
});

function runBootstrap(opts: { attr?: string; saved?: string | null; throws?: boolean; hasDark?: boolean }) {
    const classes = new Set<string>(opts.hasDark ? ['dark'] : []);
    const root = {
        getAttribute: (n: string) => (n === 'data-default-theme' ? (opts.attr ?? null) : null),
        classList: {
            add: (c: string) => void classes.add(c),
            remove: (c: string) => void classes.delete(c),
        },
    };
    const localStorage = {
        getItem: () => {
            if (opts.throws) throw new Error('blocked');
            return opts.saved ?? null;
        },
    };
    new Function('document', 'localStorage', THEME_BOOTSTRAP_SCRIPT)({ documentElement: root }, localStorage);
    return classes.has('dark');
}

describe('bootstrap script', () => {
    test('uses server default when nothing saved', () => {
        expect(runBootstrap({ attr: 'light' })).toBe(false);
        expect(runBootstrap({ attr: 'dark' })).toBe(true);
        expect(runBootstrap({})).toBe(true);
    });
    test('valid saved preference wins in both directions', () => {
        expect(runBootstrap({ attr: 'light', saved: 'dark' })).toBe(true);
        expect(runBootstrap({ attr: 'dark', saved: 'light', hasDark: true })).toBe(false);
    });
    test('invalid saved value ignored', () => {
        expect(runBootstrap({ attr: 'light', saved: 'purple' })).toBe(false);
    });
    test('blocked storage falls back to server default without throwing', () => {
        expect(runBootstrap({ attr: 'light', throws: true })).toBe(false);
        expect(runBootstrap({ attr: 'dark', throws: true })).toBe(true);
    });
    test('agrees with resolveTheme', () => {
        for (const env of ['LIGHT', 'dark', 'x', undefined]) {
            for (const saved of ['light', 'dark', 'bad', null]) {
                const expected = resolveTheme(env, saved) === 'dark';
                expect(runBootstrap({ attr: parseEnvTheme(env), saved })).toBe(expected);
            }
        }
    });
});
