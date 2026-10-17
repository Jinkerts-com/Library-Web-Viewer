/**
 * Server-only SQL construction for the shape and type facets.
 *
 * Every fragment carries its OWN bound parameter array, in placeholder order,
 * so callers compose queries by concatenating `sql` strings and `params`
 * arrays together and never reuse an array whose ordering no longer matches.
 * Only fixed SQL text and placeholders are emitted; request values are always
 * bound. Comparisons are cross-multiplied (no division), which is exact and
 * sidesteps SQLite's integer-division behaviour.
 */
import {
    NAMED_RATIOS, SHAPE_KEYS, TOLERANCE_DEN, TOLERANCE_NUM,
    type CustomRatio, type ShapeKey,
} from './itemFacets';

export type SqlParam = string | number;
export interface SqlFragment { sql: string; params: SqlParam[] }

const W = 'items.width';
const H = 'items.height';

/** Only strictly positive numeric (integer/real) dimensions classify. */
const VALID_DIMENSIONS =
    `(typeof(${W}) IN ('integer', 'real') AND typeof(${H}) IN ('integer', 'real') AND ${W} > 0 AND ${H} > 0 AND ${W} < 1e308 AND ${H} < 1e308)`;

/** Normalized extension key: ASCII-lowercase, NULL folded into the reserved empty key. */
export const TYPE_KEY_EXPR = `LOWER(COALESCE(items.ext, ''))`;

function ratioBand(tw: number, th: number): SqlFragment {
    return {
        sql: `(${W} * ? * ${TOLERANCE_NUM} >= ? * ${H} * ${TOLERANCE_DEN} AND ${W} * ? * ${TOLERANCE_DEN} <= ? * ${H} * ${TOLERANCE_NUM})`,
        params: [th, tw, th, tw],
    };
}

/** Predicate (own params) for one shape key; NULL-free (never evaluates to NULL). */
export function shapePredicate(key: ShapeKey, custom: CustomRatio): SqlFragment {
    let body: SqlFragment;
    switch (key) {
        case 'horizontal': body = { sql: `${W} > ${H}`, params: [] }; break;
        case 'vertical': body = { sql: `${W} < ${H}`, params: [] }; break;
        case 'square': body = { sql: `${W} = ${H}`, params: [] }; break;
        case 'panoramic-horizontal': body = { sql: `${W} >= 2 * ${H}`, params: [] }; break;
        case 'panoramic-vertical': body = { sql: `2 * ${W} <= ${H}`, params: [] }; break;
        case 'custom': body = ratioBand(custom.width, custom.height); break;
        default: body = ratioBand(NAMED_RATIOS[key][0], NAMED_RATIOS[key][1]);
    }
    return { sql: `(${VALID_DIMENSIONS} AND ${body.sql})`, params: body.params };
}

function anyOf(fragments: SqlFragment[]): SqlFragment {
    return { sql: `(${fragments.map(f => f.sql).join(' OR ')})`, params: fragments.flatMap(f => f.params) };
}

/**
 * `(no includes OR any included) AND NOT (any excluded)`; null when the
 * selection is empty. Exclusion wins on overlap.
 */
export function shapeFilter(included: ShapeKey[], excluded: ShapeKey[], custom: CustomRatio): SqlFragment | null {
    const parts: SqlFragment[] = [];
    if (included.length) parts.push(anyOf(included.map(k => shapePredicate(k, custom))));
    if (excluded.length) {
        const ex = anyOf(excluded.map(k => shapePredicate(k, custom)));
        parts.push({ sql: `NOT ${ex.sql}`, params: ex.params });
    }
    return joinAnd(parts);
}

export function typeFilter(included: string[], excluded: string[]): SqlFragment | null {
    const parts: SqlFragment[] = [];
    const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
    if (included.length) parts.push({ sql: `${TYPE_KEY_EXPR} IN (${marks(included.length)})`, params: [...included] });
    if (excluded.length) parts.push({ sql: `${TYPE_KEY_EXPR} NOT IN (${marks(excluded.length)})`, params: [...excluded] });
    return joinAnd(parts);
}

function joinAnd(parts: SqlFragment[]): SqlFragment | null {
    if (!parts.length) return null;
    return { sql: parts.map(p => p.sql).join(' AND '), params: parts.flatMap(p => p.params) };
}

/** Append optional filter fragments to a WHERE clause (each carries its own params). */
export function appendFilters(where: SqlFragment, ...extras: (SqlFragment | null)[]): SqlFragment {
    let sql = where.sql;
    const params = [...where.params];
    for (const e of extras) {
        if (!e) continue;
        sql += ` AND ${e.sql}`;
        params.push(...e.params);
    }
    return { sql, params };
}

/** ONE aggregate query: SUM(CASE WHEN predicate ...) per shape key over the given context. */
export function shapeCountQuery(context: SqlFragment, custom: CustomRatio): { sql: string; params: SqlParam[] } {
    const preds = SHAPE_KEYS.map(k => shapePredicate(k, custom));
    const select = preds.map((p, i) => `SUM(CASE WHEN ${p.sql} THEN 1 ELSE 0 END) AS s${i}`).join(', ');
    return {
        sql: `SELECT ${select} FROM items ${context.sql}`,
        params: [...preds.flatMap(p => p.params), ...context.params],
    };
}

export function readShapeCounts(row: Record<string, unknown> | undefined): Record<ShapeKey, number> {
    const out = {} as Record<ShapeKey, number>;
    SHAPE_KEYS.forEach((k, i) => { out[k] = Number(row?.[`s${i}`]) || 0; });
    return out;
}

export function zeroShapeCounts(): Record<ShapeKey, number> {
    return readShapeCounts(undefined);
}

export function typeCountQuery(context: SqlFragment): { sql: string; params: SqlParam[] } {
    return {
        sql: `SELECT ${TYPE_KEY_EXPR} AS ext, COUNT(*) AS count FROM items ${context.sql} GROUP BY ${TYPE_KEY_EXPR}`,
        params: [...context.params],
    };
}
