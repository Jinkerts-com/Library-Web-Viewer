import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FacetState } from '../lib/itemFacets';
import { focusOnMount, handleFacetEscape } from '../lib/facetPopoverFocus';

/**
 * Reusable shell + rows for the Shape and Types filters.
 *
 * The panel is position: fixed and positioned from the chip's bounding rect, so
 * it is never clipped by the horizontally scrolling chip row. Below `md` it
 * spans the viewport width (bounded); on desktop it is anchored under the chip.
 */

const MOBILE_QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
    const [mobile, setMobile] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia(MOBILE_QUERY);
        const update = () => setMobile(mq.matches);
        update();
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
    }, []);
    return mobile;
}

export const formatCount = (n: number | null): string => n === null ? '—' : n.toLocaleString();

interface PanelPos { top: number; left: number; width: number | null; maxHeight: number }

const DESKTOP_WIDTH = 300;
const MARGIN = 8;

function computePos(button: HTMLElement, mobile: boolean): PanelPos {
    const rect = button.getBoundingClientRect();
    const top = rect.bottom + 6;
    const maxHeight = Math.max(160, window.innerHeight - top - MARGIN);
    if (mobile) return { top, left: MARGIN, width: null, maxHeight };
    const left = Math.min(Math.max(MARGIN, rect.left), Math.max(MARGIN, window.innerWidth - DESKTOP_WIDTH - MARGIN));
    return { top, left, width: DESKTOP_WIDTH, maxHeight };
}

interface ChipProps {
    /** Visible chip label, e.g. "Shape". */
    label: string;
    /** Number of active (included + excluded) selections; drives the badge. */
    activeCount: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onClear: () => void;
    /** Optional decorative icon (an <svg> with `w-4 h-4`) shown before the label. */
    icon?: React.ReactNode;
    /** Panel body; mounted only while open, so local drafts are discarded on close. */
    children: React.ReactNode;
}

export function FacetFilterChip({ label, activeCount, open, onOpenChange, onClear, icon, children }: ChipProps) {
    const mobile = useIsMobile();
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<PanelPos | null>(null);
    const panelId = `facet-panel-${label.toLowerCase()}`;

    const reposition = useCallback(() => {
        if (buttonRef.current) setPos(computePos(buttonRef.current, mobile));
    }, [mobile]);

    useEffect(() => {
        if (!open) return;
        reposition();
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true); // the chip row scrolls too
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
        };
    }, [open, reposition]);

    // Latest callback without making effects depend on its (parent-created) identity.
    const onOpenChangeRef = useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;

    // Stable callback ref: runs only when the panel node actually mounts, so focus
    // moves into the panel once per opening and never on later re-renders.
    const panelFocus = useMemo(() => focusOnMount(), []);
    const setPanelNode = useCallback((node: HTMLDivElement | null) => {
        panelRef.current = node;
        panelFocus(node);
    }, [panelFocus]);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
            onOpenChangeRef.current(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    const onEscapeKey = (e: React.KeyboardEvent) => {
        if (handleFacetEscape(e.key, () => onOpenChangeRef.current(false), buttonRef.current)) e.stopPropagation();
    };

    return (
        <div className="relative shrink-0">
            <button
                ref={buttonRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                onClick={() => onOpenChange(!open)}
                onKeyDown={e => { if (open) onEscapeKey(e); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${activeCount > 0 || open
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40'
                    : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            >
                {icon}
                {label}
                {activeCount > 0 && (
                    <span className="min-w-[1.25rem] px-1 rounded-full bg-blue-600 text-white text-xs leading-5 text-center" aria-label={`${activeCount} active`}>
                        {activeCount.toLocaleString()}
                    </span>
                )}
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" /></svg>
            </button>

            {open && pos && (
                <div
                    ref={setPanelNode}
                    id={panelId}
                    role="dialog"
                    aria-label={`${label} filter`}
                    tabIndex={-1}
                    onKeyDown={onEscapeKey}
                    style={{ position: 'fixed', top: pos.top, left: pos.left, ...(pos.width ? { width: pos.width } : { right: MARGIN }), maxHeight: pos.maxHeight }}
                    className="z-50 flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl rounded-lg overflow-hidden focus:outline-none"
                >
                    <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
                        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{label}</span>
                        <button
                            type="button"
                            onClick={onClear}
                            disabled={activeCount === 0}
                            className="text-xs px-2 py-1 rounded text-blue-600 dark:text-blue-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
                        >
                            Clear
                        </button>
                    </div>
                    <div className="overflow-y-auto p-1.5">{children}</div>
                    <div className="px-3 py-1.5 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 text-xs text-zinc-500">
                        Click to include. Right-click or Alt-click to exclude.
                    </div>
                </div>
            )}
        </div>
    );
}

interface RowProps {
    label: string;
    /** null = unavailable (loading / failed), shown as an em dash, never as 0. */
    count: number | null;
    state: FacetState;
    onToggle: () => void;
    onExclude: () => void;
    /** Extra control after the count (e.g. the Custom expander). */
    trailing?: React.ReactNode;
    /** Content under the row (e.g. the Custom ratio editor). */
    children?: React.ReactNode;
}

export function FacetRow({ label, count, state, onToggle, onExclude, trailing, children }: RowProps) {
    const excluded = state === 'excluded';
    return (
        <li
            className="rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onContextMenu={e => { e.preventDefault(); onExclude(); }}
        >
            <div className="flex items-center gap-1">
                <label
                    className="flex flex-1 min-w-0 items-center gap-2.5 pl-2.5 py-1.5 cursor-pointer select-none"
                    onClick={e => { if (e.altKey) { e.preventDefault(); onExclude(); } }}
                >
                    <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={state === 'included'}
                        onChange={onToggle}
                    />
                    <div className={`w-4 h-4 shrink-0 border rounded flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-1 dark:peer-focus-visible:ring-offset-zinc-900 ${state === 'included' ? 'bg-blue-500 border-blue-500' : excluded ? 'bg-red-500 border-red-500' : 'border-zinc-400'}`}>
                        {state === 'included' && <svg className="w-3 h-3 text-white fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>}
                        {excluded && <svg className="w-3 h-3 text-white fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>}
                    </div>
                    <span className={`text-sm flex-1 truncate ${excluded ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-300'}`}>{label}</span>
                    {excluded && <span className="sr-only">Excluded</span>}
                </label>
                <span className="text-xs text-zinc-500 tabular-nums shrink-0 min-w-[2rem] text-right" aria-label={count === null ? 'count unavailable' : `${count.toLocaleString()} items`}>
                    {formatCount(count)}
                </span>
                {trailing}
            </div>
            {children}
        </li>
    );
}
