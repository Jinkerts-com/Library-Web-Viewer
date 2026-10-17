import { describe, expect, test } from 'bun:test';
import {
    buildBreadcrumbs,
    findFolderPath,
    findProtectedFolder,
    specialViewLabel,
    ROOT_LABEL,
    UNKNOWN_FOLDER_LABEL,
    UNTITLED_FOLDER_LABEL,
    type FolderNode,
} from '../src/lib/folderPaths';
import { dateAdded, formatDuration, formatTimestamp, ratingStars } from '../src/lib/itemTypes';

const tree: FolderNode[] = [
    { id: 'a', name: 'A', children: [{ id: 'a1', name: 'A1', children: [{ id: 'a1x', name: 'A1X', children: [] }] }] },
    { id: 'b', name: 'B', children: [] },
];

describe('findFolderPath', () => {
    test('top-level folder', () => {
        expect(findFolderPath(tree, 'b')?.map(f => f.id)).toEqual(['b']);
    });
    test('nested folder returns ancestors in order', () => {
        expect(findFolderPath(tree, 'a1x')?.map(f => f.id)).toEqual(['a', 'a1', 'a1x']);
    });
    test('missing, empty and unknown ids return null', () => {
        expect(findFolderPath(tree, null)).toBeNull();
        expect(findFolderPath(tree, '')).toBeNull();
        expect(findFolderPath(tree, 'nope')).toBeNull();
        expect(findFolderPath([], 'a')).toBeNull();
        expect(findFolderPath(undefined, 'a')).toBeNull();
    });
    test('cyclic data terminates', () => {
        const x: FolderNode = { id: 'x', name: 'X', children: [] };
        const y: FolderNode = { id: 'y', name: 'Y', children: [x] };
        x.children!.push(y);
        expect(findFolderPath([x], 'zzz')).toBeNull();
        expect(findFolderPath([x], 'y')?.map(f => f.id)).toEqual(['x', 'y']);
    });
    test('corrupt children/entries are skipped', () => {
        const bad = [null, { id: 'q', name: 'Q', children: 'oops' }, { id: 'r', name: 'R', children: [undefined, { id: 's', name: 'S' }] }] as unknown as FolderNode[];
        expect(findFolderPath(bad, 's')?.map(f => f.id)).toEqual(['r', 's']);
        expect(findFolderPath(bad, 'zzz')).toBeNull();
    });
});

describe('buildBreadcrumbs', () => {
    test('root view is a single current "All" crumb', () => {
        const c = buildBreadcrumbs(tree, { folderId: null, specialFilter: null });
        expect(c).toHaveLength(1);
        expect(c[0]).toMatchObject({ label: ROOT_LABEL, current: true, navigable: false });
    });
    test('nested folder: root and ancestors navigable, current is not', () => {
        const c = buildBreadcrumbs(tree, { folderId: 'a1x', specialFilter: null });
        expect(c.map(x => x.label)).toEqual(['All', 'A', 'A1', 'A1X']);
        expect(c.map(x => x.navigable)).toEqual([true, true, true, false]);
        expect(c.map(x => x.folderId)).toEqual([null, 'a', 'a1', 'a1x']);
        expect(c.filter(x => x.current).map(x => x.label)).toEqual(['A1X']);
    });
    test('unknown folder id degrades gracefully', () => {
        const c = buildBreadcrumbs(tree, { folderId: 'gone', specialFilter: null });
        expect(c.map(x => x.label)).toEqual(['All', UNKNOWN_FOLDER_LABEL]);
        expect(c[1].navigable).toBe(false);
        expect(buildBreadcrumbs([], { folderId: 'a', specialFilter: null })[1].label).toBe(UNKNOWN_FOLDER_LABEL);
    });
    test('blank folder name gets a placeholder', () => {
        const c = buildBreadcrumbs([{ id: 'n', name: '  ' }], { folderId: 'n', specialFilter: null });
        expect(c[1].label).toBe(UNTITLED_FOLDER_LABEL);
    });
    test('special views win over folder id', () => {
        const c = buildBreadcrumbs(tree, { folderId: 'a', specialFilter: 'trash' });
        expect(c.map(x => x.label)).toEqual(['Trash']);
        expect(c[0].navigable).toBe(false);
    });
});

describe('specialViewLabel', () => {
    test('matches sidebar wording', () => {
        expect(specialViewLabel('uncategorized')).toBe('Uncategorized');
        expect(specialViewLabel('untagged')).toBe('Untagged');
        expect(specialViewLabel('random')).toBe('Random');
        expect(specialViewLabel('trash')).toBe('Trash');
    });
    test('null/unknown/prototype keys give null', () => {
        expect(specialViewLabel(null)).toBeNull();
        expect(specialViewLabel('')).toBeNull();
        expect(specialViewLabel('bogus')).toBeNull();
        expect(specialViewLabel('toString')).toBeNull();
        expect(specialViewLabel('__proto__')).toBeNull();
    });
});

describe('formatTimestamp', () => {
    test('valid ms yields a non-empty string', () => {
        const s = formatTimestamp(1792204534926, 'en-US');
        expect(s).toContain('2026');
    });
    test('0, negative, null, undefined, NaN, Infinity, strings, out-of-range -> null', () => {
        for (const v of [0, -5, null, undefined, NaN, Infinity, 'abc', '1792204534926', {}, 8.64e15 + 1]) {
            expect(formatTimestamp(v)).toBeNull();
        }
    });
    test('never contains "Invalid Date"', () => {
        for (const v of [0, NaN, 'x', undefined, 1e20, 1792204534926]) {
            expect(String(formatTimestamp(v))).not.toContain('Invalid Date');
        }
    });
});

describe('dateAdded (btime fallback honesty)', () => {
    const mtime = 1792204534926;
    test('distinct btime is shown', () => {
        expect(dateAdded({ btime: mtime - 86_400_000, modificationTime: mtime }, 'en-US')).toContain('2026');
    });
    test('btime equal to modificationTime is indistinguishable from the scanner fallback -> omitted', () => {
        expect(dateAdded({ btime: mtime, modificationTime: mtime })).toBeNull();
    });
    test('missing/zero/invalid btime -> omitted', () => {
        expect(dateAdded({ modificationTime: mtime })).toBeNull();
        expect(dateAdded({ btime: 0, modificationTime: mtime })).toBeNull();
        expect(dateAdded({ btime: null, modificationTime: mtime })).toBeNull();
        expect(dateAdded({ btime: NaN, modificationTime: mtime })).toBeNull();
    });
});

describe('formatDuration', () => {
    test('fractional seconds floor to m:ss', () => {
        expect(formatDuration(66.64127)).toBe('1:06');
        expect(formatDuration(315.466304)).toBe('5:15');
        expect(formatDuration(5)).toBe('0:05');
        expect(formatDuration(59.999)).toBe('0:59');
        expect(formatDuration(60)).toBe('1:00');
    });
    test('hours use h:mm:ss', () => {
        expect(formatDuration(3600)).toBe('1:00:00');
        expect(formatDuration(3661.9)).toBe('1:01:01');
        expect(formatDuration(36000 + 125)).toBe('10:02:05');
    });
    test('0, missing, negative, invalid -> null', () => {
        for (const v of [0, -1, null, undefined, NaN, Infinity, '66', {}]) {
            expect(formatDuration(v)).toBeNull();
        }
    });
});

describe('formatting boundaries', () => {
    test('sub-second positive duration floors to "0:00" (whole seconds, never rounded up)', () => {
        expect(formatDuration(0.5)).toBe('0:00');
        expect(formatDuration(0.999)).toBe('0:00');
        expect(formatDuration(1)).toBe('0:01');
    });
    test('distinct but out-of-range btime is omitted, not "Invalid Date"', () => {
        expect(dateAdded({ btime: 8.64e15 + 1, modificationTime: 5 })).toBeNull();
        expect(dateAdded({ btime: 1e20, modificationTime: 5 })).toBeNull();
    });
    test('invalid locale tag yields null instead of throwing', () => {
        expect(() => formatTimestamp(1792204534926, 'not a locale!!')).not.toThrow();
        expect(formatTimestamp(1792204534926, 'not a locale!!')).toBeNull();
    });
});

describe('findProtectedFolder (lock-screen hint source)', () => {
    type F = { id: string; name: string; hasPassword?: boolean; passwordTips?: string; children?: F[] };
    const nested: F[] = [
        { id: 'top', name: 'Top', hasPassword: true, passwordTips: 'top hint', children: [
            { id: 'mid', name: 'Mid', children: [
                { id: 'leaf', name: 'Leaf', children: [] },
                { id: 'inner', name: 'Inner', hasPassword: true, passwordTips: 'inner hint', children: [
                    { id: 'deep', name: 'Deep', children: [] },
                ] },
            ] },
        ] },
        { id: 'plain', name: 'Plain', children: [] },
    ];
    test('inherits the hint from a protected ancestor', () => {
        expect(findProtectedFolder(nested, 'leaf')?.passwordTips).toBe('top hint');
        expect(findProtectedFolder(nested, 'mid')?.id).toBe('top');
    });
    test('a nearer protected folder wins over a farther one', () => {
        expect(findProtectedFolder(nested, 'deep')?.passwordTips).toBe('inner hint');
        expect(findProtectedFolder(nested, 'inner')?.id).toBe('inner');
    });
    test('the folder itself counts; unprotected tree and unknown ids give null', () => {
        expect(findProtectedFolder(nested, 'top')?.id).toBe('top');
        expect(findProtectedFolder(nested, 'plain')).toBeNull();
        expect(findProtectedFolder(nested, 'nope')).toBeNull();
        expect(findProtectedFolder(null, 'top')).toBeNull();
    });
});

describe('ratingStars', () => {
    test('1..5 shown; unrated and unobserved shapes hidden', () => {
        expect(ratingStars(1)).toBe(1);
        expect(ratingStars(5)).toBe(5);
        for (const v of [0, -1, 6, 3.5, NaN, null, undefined, '3']) {
            expect(ratingStars(v)).toBeNull();
        }
    });
});

describe('verified real-library folder shapes (named iconColor, passwordTips string)', () => {
    test('eagleColor maps the observed iconColor names', async () => {
        const { eagleColor } = await import('../src/lib/eagleColors');
        expect(eagleColor('red')).toBe('#EB5757');
        expect(eagleColor('purple')).toBe('#9B51E0');
    });
    test('sanitizeFolders strips password but passes passwordTips/iconColor through', async () => {
        const { sanitizeFolders } = await import('../src/lib/metaHandler');
        const [locked, colored] = sanitizeFolders([
            { id: 'L', name: 'Test Locked', password: 'secret', passwordTips: 'a hint', children: [] } as any,
            { id: 'C', name: 'Test Folder', password: '', iconColor: 'red', children: [] } as any,
        ]) as any[];
        expect(locked.password).toBeUndefined();
        expect(locked.hasPassword).toBe(true);
        expect(locked.passwordTips).toBe('a hint');
        expect(colored.hasPassword).toBe(false);
        expect(colored.iconColor).toBe('red');
    });
});
