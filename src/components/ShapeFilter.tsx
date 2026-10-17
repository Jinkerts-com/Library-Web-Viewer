import React, { useState } from 'react';
import { useStore } from '@nanostores/react';
import {
    filtersStore, shapeCountsStore, toggleShape, toggleShapeExclude, clearShapeFilter, setCustomRatio,
} from '../stores/libraryStore';
import { SHAPE_KEYS, SHAPE_LABELS, facetState, parseCustomRatio, type ShapeKey } from '../lib/itemFacets';
import { FacetFilterChip, FacetRow } from './FacetFilterPopover';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

function ShapePanelBody() {
    const filters = useStore(filtersStore);
    const counts = useStore(shapeCountsStore);
    const sel = { included: filters.includedShapes, excluded: filters.excludedShapes };
    const { customRatio } = filters;

    // Drafts are local to this panel body, which unmounts on close (discarding them)
    const [editorOpen, setEditorOpen] = useState(false);
    const [draftW, setDraftW] = useState(String(customRatio.width));
    const [draftH, setDraftH] = useState(String(customRatio.height));
    const [errors, setErrors] = useState<{ width: string | null; height: string | null }>({ width: null, height: null });
    const [applied, setApplied] = useState<string | null>(null);

    const apply = () => {
        const parsed = parseCustomRatio(draftW.trim(), draftH.trim());
        if (!parsed.ok) {
            setErrors({ width: parsed.widthError, height: parsed.heightError });
            setApplied(null);
            return; // an invalid draft never changes the active query
        }
        setErrors({ width: null, height: null });
        setCustomRatio(parsed.value);
        setDraftW(String(parsed.value.width));
        setDraftH(String(parsed.value.height));
        setApplied(`Custom ratio set to ${parsed.value.width}:${parsed.value.height}`);
    };

    const rowLabel = (key: ShapeKey) =>
        key === 'custom' ? `Custom (${customRatio.width}:${customRatio.height})` : SHAPE_LABELS[key];

    return (
        <ul className="space-y-0.5" aria-label="Shapes">
            {SHAPE_KEYS.map(key => {
                const isCustom = key === 'custom';
                return (
                    <FacetRow
                        key={key}
                        label={rowLabel(key)}
                        count={counts ? counts[key] : null}
                        state={facetState(sel, key)}
                        onToggle={() => { toggleShape(key); if (isCustom && facetState(sel, key) === 'neutral') setEditorOpen(true); }}
                        onExclude={() => { toggleShapeExclude(key); if (isCustom && facetState(sel, key) !== 'excluded') setEditorOpen(true); }}
                        trailing={isCustom ? (
                            <button
                                type="button"
                                aria-expanded={editorOpen}
                                aria-controls="shape-custom-editor"
                                aria-label="Edit custom ratio"
                                title="Edit custom ratio"
                                onClick={() => setEditorOpen(v => !v)}
                                className="shrink-0 p-1.5 mr-1 rounded text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            >
                                <svg className={`w-4 h-4 transition-transform ${editorOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" /></svg>
                            </button>
                        ) : undefined}
                    >
                        {isCustom && editorOpen && (
                            <form
                                id="shape-custom-editor"
                                className="px-2.5 pb-2.5 pt-1"
                                onSubmit={e => { e.preventDefault(); apply(); }}
                                noValidate
                            >
                                <div className="flex items-start gap-2">
                                    <div className="flex-1 min-w-0">
                                        <label className="block text-xs text-zinc-500 mb-0.5" htmlFor="shape-ratio-w">Width</label>
                                        <input
                                            id="shape-ratio-w"
                                            type="text"
                                            inputMode="numeric"
                                            autoComplete="off"
                                            value={draftW}
                                            onChange={e => { setDraftW(e.target.value); setApplied(null); }}
                                            aria-invalid={errors.width !== null}
                                            aria-describedby={errors.width ? 'shape-ratio-w-err' : undefined}
                                            className="w-full px-2 py-1 text-sm bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        />
                                        {errors.width && <p id="shape-ratio-w-err" role="alert" className="text-xs text-red-600 dark:text-red-400 mt-0.5">{errors.width}</p>}
                                    </div>
                                    <span className="pt-6 text-zinc-500" aria-hidden="true">:</span>
                                    <div className="flex-1 min-w-0">
                                        <label className="block text-xs text-zinc-500 mb-0.5" htmlFor="shape-ratio-h">Height</label>
                                        <input
                                            id="shape-ratio-h"
                                            type="text"
                                            inputMode="numeric"
                                            autoComplete="off"
                                            value={draftH}
                                            onChange={e => { setDraftH(e.target.value); setApplied(null); }}
                                            aria-invalid={errors.height !== null}
                                            aria-describedby={errors.height ? 'shape-ratio-h-err' : undefined}
                                            className="w-full px-2 py-1 text-sm bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        />
                                        {errors.height && <p id="shape-ratio-h-err" role="alert" className="text-xs text-red-600 dark:text-red-400 mt-0.5">{errors.height}</p>}
                                    </div>
                                    <button
                                        type="submit"
                                        className="mt-5 px-3 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                                    >
                                        Apply
                                    </button>
                                </div>
                                <p className="text-xs text-zinc-500 mt-1" role="status">{applied ?? 'Whole numbers 1 to 10,000.'}</p>
                            </form>
                        )}
                    </FacetRow>
                );
            })}
        </ul>
    );
}

export default function ShapeFilter({ open, onOpenChange }: Props) {
    const filters = useStore(filtersStore);
    return (
        <FacetFilterChip
            label="Shape"
            activeCount={filters.includedShapes.length + filters.excludedShapes.length}
            open={open}
            onOpenChange={onOpenChange}
            onClear={clearShapeFilter}
        >
            <ShapePanelBody />
        </FacetFilterChip>
    );
}
