import { describe, expect, test } from 'bun:test';
import { sortFoldersByName } from '../src/lib/folderPresentation';

describe('sortFoldersByName', () => {
    test('sorts alphabetically', () => {
        const out = sortFoldersByName([{ name: 'b' }, { name: 'C' }, { name: 'a' }]);
        expect(out.map(f => f.name)).toEqual(['a', 'b', 'C']);
    });

    test('does not mutate frozen input and returns a new array', () => {
        const input = Object.freeze([
            Object.freeze({ name: 'z', children: Object.freeze([]) }),
            Object.freeze({ name: 'a', children: Object.freeze([]) }),
        ]);
        const out = sortFoldersByName(input);
        expect(out.map(f => f.name)).toEqual(['a', 'z']);
        expect(input.map(f => f.name)).toEqual(['z', 'a']);
        expect(out as unknown).not.toBe(input);
    });

    test('sorting nested children level by level leaves originals intact', () => {
        const tree = Object.freeze([
            Object.freeze({
                name: 'root',
                children: Object.freeze([{ name: 'y' }, { name: 'x' }]),
            }),
        ]);
        const root = sortFoldersByName(tree)[0];
        expect(sortFoldersByName(root.children).map(f => f.name)).toEqual(['x', 'y']);
        expect(root.children.map(f => f.name)).toEqual(['y', 'x']);
    });

    test('empty input', () => {
        expect(sortFoldersByName([])).toEqual([]);
    });
});
