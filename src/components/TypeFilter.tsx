import React from 'react';
import { useStore } from '@nanostores/react';
import {
    filtersStore, typeCountsStore, toggleType, toggleTypeExclude, clearTypeFilter,
} from '../stores/libraryStore';
import { facetState, typeLabel } from '../lib/itemFacets';
import { FacetFilterChip, FacetRow } from './FacetFilterPopover';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

function TypePanelBody() {
    const filters = useStore(filtersStore);
    const counts = useStore(typeCountsStore);
    const sel = { included: filters.includedTypes, excluded: filters.excludedTypes };

    // File types present in the current view, plus any selected type that has
    // disappeared from it (kept at 0 so it can still be cleared)
    const keys = new Set<string>([...(counts ? Object.keys(counts) : []), ...sel.included, ...sel.excluded]);
    const rows = [...keys]
        .map(key => ({ key, label: typeLabel(key) }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

    if (rows.length === 0) {
        return (
            <p className="px-3 py-4 text-sm text-zinc-500 text-center" role="status">
                {counts ? 'No file types in this view' : 'File types unavailable'}
            </p>
        );
    }

    return (
        <ul className="space-y-0.5" aria-label="File types">
            {rows.map(({ key, label }) => (
                <FacetRow
                    key={key}
                    label={label}
                    // Unavailable counts stay null; a loaded context without the type is a real 0
                    count={counts ? (Object.prototype.hasOwnProperty.call(counts, key) ? counts[key] : 0) : null}
                    state={facetState(sel, key)}
                    onToggle={() => toggleType(key)}
                    onExclude={() => toggleTypeExclude(key)}
                />
            ))}
        </ul>
    );
}

export default function TypeFilter({ open, onOpenChange }: Props) {
    const filters = useStore(filtersStore);
    return (
        <FacetFilterChip
            label="Types"
            activeCount={filters.includedTypes.length + filters.excludedTypes.length}
            open={open}
            onOpenChange={onOpenChange}
            onClear={clearTypeFilter}
        >
            <TypePanelBody />
        </FacetFilterChip>
    );
}
