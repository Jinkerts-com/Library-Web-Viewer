import React, { useEffect, useState, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { filtersStore, tagsGroupsStore } from '../stores/libraryStore';
import { eagleColor } from '../lib/eagleColors';
import { downloadLinkProps, openOriginalLinkProps, originalUrl, previewUrl, thumbnailUrl } from '../lib/mediaUrls';
import { AUDIO_PLAY_EXTS, IMAGE_RENDER_EXTS, VIDEO_PLAY_EXTS } from '../lib/mime';
import { dateAdded, formatDuration, formatTimestamp, ratingStars, MAX_RATING, type LibraryItem } from '../lib/itemTypes';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import type { ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch';
import type { NavStatus } from '../lib/modalNavigation';

type Item = LibraryItem;

const isPlayableExt = (ext: string) =>
    ([...VIDEO_PLAY_EXTS, ...AUDIO_PLAY_EXTS] as readonly string[]).includes(ext.toLowerCase());

interface ModalProps {
    item: Item | null;
    nextItem?: Item | null;
    prevItem?: Item | null;
    isOpen: boolean;
    onClose: () => void;
    onNext: () => void;
    onPrev: () => void;
    hasNext: boolean;
    hasPrev: boolean;
    /** Pending/failed boundary navigation (next page / last item); the current media stays visible. */
    navStatus?: NavStatus | null;
    onRetryNav?: () => void;
    onCancelNav?: () => void;
}

// Keys typed into or gestures made on these must never navigate (e.g. arrow keys on the zoom slider)
const INTERACTIVE_SELECTOR = 'input, textarea, select, button, a, [contenteditable="true"], [data-no-swipe]';

export default function Modal({ item, nextItem, prevItem, isOpen, onClose, onNext, onPrev, hasNext, hasPrev, navStatus, onRetryNav, onCancelNav }: ModalProps) {
    const [infoOpen, setInfoOpen] = useState(false);
    const tagsGroups = useStore(tagsGroupsStore);
    const touchStartX = useRef(0);
    const zoomScale = useRef(1);
    const lastPinchTime = useRef(0);
    const [sliderValue, setSliderValue] = useState(1);

    // Reset zoom state on new image
    useEffect(() => {
        zoomScale.current = 1;
        setSliderValue(1);
    }, [item?.id]);

    // --- Bottom Sheet Swipe Handlers (Mobile) ---
    const panelRef = useRef<HTMLDivElement>(null);
    const [sheetOffset, setSheetOffset] = useState(0);
    const sheetTouchStartY = useRef(0);
    const sheetCurrentY = useRef(0);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!isOpen) return;
            if (e.key === 'Escape') onClose();
            const target = e.target instanceof Element ? e.target : null;
            if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
            if (e.key === 'ArrowRight' && hasNext) onNext();
            if (e.key === 'ArrowLeft' && hasPrev) onPrev();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, hasNext, hasPrev, onClose, onNext, onPrev]);

    // Reset offset when info panel closes
    useEffect(() => {
        if (!infoOpen) {
            setSheetOffset(0);
        }
    }, [infoOpen]);

    // Focus management: move focus into the dialog on open, restore on close
    const modalRef = useRef<HTMLDivElement>(null);
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const previousFocus = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (isOpen) {
            previousFocus.current = document.activeElement as HTMLElement | null;
            closeBtnRef.current?.focus();
            return () => previousFocus.current?.focus();
        }
    }, [isOpen]);

    const handleTrapTab = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab' || !modalRef.current) return;
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input, video, audio, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };

    if (!isOpen || !item) return null;

    const getOriginalUrl = (itm: Item) => originalUrl(itm.id, itm.name, itm.ext);

    const getFullResUrl = (itm: Item) => {
        if ((IMAGE_RENDER_EXTS as readonly string[]).includes(itm.ext.toLowerCase())) {
            return getOriginalUrl(itm);
        }
        return previewUrl(itm.id);
    };

    const isVideo = (VIDEO_PLAY_EXTS as readonly string[]).includes(item.ext.toLowerCase());
    const isAudio = (AUDIO_PLAY_EXTS as readonly string[]).includes(item.ext.toLowerCase());
    const fullResUrl = isVideo || isAudio ? getOriginalUrl(item) : getFullResUrl(item);

    // Read-only metadata; each helper returns null for absent/zero/invalid values
    const duration = formatDuration(item.duration);
    const rating = ratingStars(item.star);
    const added = dateAdded(item);
    const modified = formatTimestamp(item.modificationTime);

    const formatBytes = (bytes: number, decimals = 2) => {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    };

    // --- Media Swipe Handlers ---
    const handleTouchStart = (e: React.TouchEvent) => {
        if (e.touches.length > 1) {
            lastPinchTime.current = Date.now();
        }

        // Only track single touch points, and never ones that start on a control
        const onControl = e.target instanceof Element && !!e.target.closest(INTERACTIVE_SELECTOR);
        if (e.touches.length === 1 && zoomScale.current <= 1.05 && !onControl) {
            touchStartX.current = e.touches[0].screenX;
        } else {
            touchStartX.current = 0;
        }
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        if (Date.now() - lastPinchTime.current < 300) return;
        if (touchStartX.current === 0 || zoomScale.current > 1.05) return;
        const touchEndX = e.changedTouches[0].screenX;
        const swipeDistance = touchEndX - touchStartX.current;
        if (swipeDistance > 50 && hasPrev) onPrev(); // Swipe right -> prev
        if (swipeDistance < -50 && hasNext) onNext(); // Swipe left -> next
        touchStartX.current = 0;
    };

    // --- Bottom Sheet Swipe Handlers (Mobile) ---
    const handleSheetTouchStart = (e: React.TouchEvent) => {
        // Only trigger on mobile (where we don't have md: styles taking over)
        if (window.innerWidth >= 768) return;

        // Ensure we're dragging from the handle area to prevent conflict with internal scrolling
        if ((e.target as HTMLElement).closest('.drag-handle-area')) {
            sheetTouchStartY.current = e.touches[0].screenY;
            sheetCurrentY.current = e.touches[0].screenY;
        } else {
            sheetTouchStartY.current = 0;
        }
    };

    const handleSheetTouchMove = (e: React.TouchEvent) => {
        if (sheetTouchStartY.current === 0) return;
        sheetCurrentY.current = e.touches[0].screenY;
        const deltaY = sheetCurrentY.current - sheetTouchStartY.current;

        // Only allow dragging downwards
        if (deltaY > 0) {
            setSheetOffset(deltaY);
        }
    };

    const handleSheetTouchEnd = () => {
        if (sheetTouchStartY.current === 0) return;

        const deltaY = sheetCurrentY.current - sheetTouchStartY.current;
        // If dragged down more than 100px, close the panel
        if (deltaY > 100) {
            setInfoOpen(false);
        }

        // Reset state
        setSheetOffset(0);
        sheetTouchStartY.current = 0;
    };

    const handleTagClick = (tag: string) => {
        filtersStore.setKey('includedTags', [tag]);
        onClose();
    };

    // Tags take their color from the group they belong to
    const tagColor = (tag: string): string | null => {
        for (const group of tagsGroups) {
            if (group.tags.includes(tag)) {
                const c = eagleColor(group.color);
                if (c) return c;
            }
        }
        return null;
    };

    return (
        <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label={item.name}
            className="fixed inset-0 z-[3000] w-full h-full bg-black/85 dark:bg-black/95 overflow-hidden font-sans"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onKeyDown={handleTrapTab}
        >
            {/* Preload Next/Prev Images */}
            <div style={{ display: 'none' }}>
                {nextItem && !isPlayableExt(nextItem.ext) && (
                    <img src={getFullResUrl(nextItem)} alt="preload next" />
                )}
                {prevItem && !isPlayableExt(prevItem.ext) && (
                    <img src={getFullResUrl(prevItem)} alt="preload prev" />
                )}
            </div>

            {/* Main Content Area (Shrinks when info is open on desktop) */}
            <div
                className="absolute top-0 left-0 h-full transition-all duration-300 w-full md:w-auto"
                style={{ right: infoOpen ? '300px' : '0' }}
                onClick={(e) => {
                    if (e.target === e.currentTarget) {
                        if (infoOpen) setInfoOpen(false);
                        else onClose();
                    }
                }}
            >
                {/* Navigation Buttons */}
                <button
                    className={`absolute top-1/2 left-4 -translate-y-1/2 text-3xl text-white cursor-pointer select-none bg-black/40 hover:bg-black/80 rounded-full transition-colors z-10 flex items-center justify-center w-12 h-12 shadow-lg backdrop-blur-sm ${!hasPrev ? 'opacity-20 cursor-default pointer-events-none' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onPrev(); }}
                    disabled={!hasPrev}
                    aria-label="Previous item"
                >
                    &#10094;
                </button>
                <button
                    className={`absolute top-1/2 right-4 -translate-y-1/2 text-3xl text-white cursor-pointer select-none bg-black/40 hover:bg-black/80 rounded-full transition-colors z-10 flex items-center justify-center w-12 h-12 shadow-lg backdrop-blur-sm ${!hasNext ? 'opacity-20 cursor-default pointer-events-none' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onNext(); }}
                    disabled={!hasNext}
                    aria-label="Next item"
                >
                    &#10095;
                </button>

                {/* Top Controls: one action row on mobile (safe-area aware); md+ dissolves the
                    row (display: contents) so each action keeps its absolute desktop position. */}
                <div className="absolute inset-x-0 top-0 z-50 flex items-center justify-end gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pointer-events-none md:contents">
                <button
                    className={`relative md:absolute md:top-4 md:right-16 bg-black/40 hover:bg-black/80 text-white rounded-full w-11 h-11 md:w-10 md:h-10 cursor-pointer z-50 font-bold flex items-center justify-center transition-colors shadow-lg backdrop-blur-sm pointer-events-auto ${infoOpen ? 'bg-black/80 text-blue-400' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setInfoOpen(!infoOpen); }}
                    title="Toggle Info"
                    aria-label="Toggle info panel"
                    aria-expanded={infoOpen}
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </button>
                {/* Original actions: plain links, so keyboard/arrow handling (window-level) is untouched.
                    Download is a server attachment (streamed, Range/auth/304 intact); SVG is always
                    served as an attachment, so "open" downloads it instead of running it on this origin. */}
                <a
                    {...downloadLinkProps(item.id, item.name, item.ext)}
                    className="relative md:absolute md:top-4 md:right-28 text-white hover:text-blue-400 bg-black/40 hover:bg-black/80 w-11 h-11 md:w-10 md:h-10 rounded-full flex items-center justify-center cursor-pointer z-50 transition-colors shadow-lg backdrop-blur-sm pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                    title="Download original"
                    aria-label="Download original"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"></path></svg>
                </a>
                <a
                    {...openOriginalLinkProps(item.id, item.name, item.ext)}
                    className="relative md:absolute md:top-4 md:right-40 text-white hover:text-blue-400 bg-black/40 hover:bg-black/80 w-11 h-11 md:w-10 md:h-10 rounded-full flex items-center justify-center cursor-pointer z-50 transition-colors shadow-lg backdrop-blur-sm pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                    title="Open original in new tab"
                    aria-label="Open original in new tab"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                </a>
                <button
                    ref={closeBtnRef}
                    className="relative md:absolute md:top-4 md:right-4 text-white hover:text-red-400 bg-black/40 hover:bg-black/80 w-11 h-11 md:w-10 md:h-10 rounded-full flex items-center justify-center cursor-pointer z-50 transition-colors shadow-lg backdrop-blur-sm pointer-events-auto"
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    title="Close"
                    aria-label="Close"
                >
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
                </div>

                {/* Boundary navigation status: compact, never replaces the current media */}
                {navStatus && (
                    <div
                        role="status"
                        data-no-swipe
                        className="absolute left-1/2 -translate-x-1/2 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+3.5rem)] md:bottom-6 z-50 max-w-[calc(100vw-1.5rem)] flex items-center gap-3 bg-black/70 backdrop-blur-sm text-white text-sm rounded-full px-4 py-2 shadow-lg pointer-events-auto"
                    >
                        {navStatus.phase === 'loading' ? (
                            <>
                                <span className="border-2 border-white/30 border-t-white rounded-full w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                                <span>{navStatus.direction === 'previous-wrap' ? 'Loading last item…' : 'Loading next items…'}</span>
                            </>
                        ) : (
                            <>
                                <span className="truncate">{navStatus.message || 'Failed to load items'}</span>
                                <button type="button" onClick={(e) => { e.stopPropagation(); onRetryNav?.(); }} className="px-3 min-h-[44px] md:min-h-0 rounded-full bg-blue-600 hover:bg-blue-500">Retry</button>
                            </>
                        )}
                        <button type="button" onClick={(e) => { e.stopPropagation(); onCancelNav?.(); }} className="px-3 min-h-[44px] md:min-h-0 rounded-full hover:bg-white/20" aria-label="Cancel navigation">Cancel</button>
                    </div>
                )}

                {/* Media Wrapper: on mobile, top/bottom space is reserved for the control bands */}
                <div
                    className="w-full h-full flex items-center justify-center p-4 pt-[calc(4.5rem+env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom))] md:p-12 pointer-events-none"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            if (infoOpen) setInfoOpen(false);
                            else onClose();
                        }
                    }}
                >
                    {isVideo ? (
                        <video src={fullResUrl} controls autoPlay className="max-w-full max-h-full object-contain pointer-events-auto rounded-lg shadow-2xl" />
                    ) : isAudio ? (
                        <div className="flex flex-col items-center justify-center w-full h-full px-12 box-border pointer-events-auto">
                            <img
                                src={thumbnailUrl(item.id)}
                                className="max-w-[500px] max-h-[500px] mb-10 object-contain rounded-lg shadow-2xl"
                                alt="Cover"
                                loading="eager"
                                decoding="async"
                                fetchPriority="high"
                            />
                            <audio src={fullResUrl} controls autoPlay className="w-full mt-auto mb-auto" />
                        </div>
                    ) : (
                        <TransformWrapper
                            key={item.id}
                            initialScale={1}
                            minScale={0.5}
                            maxScale={10}
                            centerOnInit={true}
                            wheel={{ step: 0.1 }}
                            doubleClick={{ disabled: true }}
                            onTransformed={(ref) => {
                                zoomScale.current = ref.state.scale;
                                setSliderValue(ref.state.scale);
                            }}
                            onZoom={(ref) => {
                                zoomScale.current = ref.state.scale;
                                setSliderValue(ref.state.scale);
                            }}
                        >
                            {({ instance, zoomIn, zoomOut, setTransform }: ReactZoomPanPinchContentRef) => (
                                <>
                                    {/* Zoom Controls */}
                                    {/* Bottom band on mobile (above the safe-area inset, bounded to the viewport); top-centered on md+ */}
                                    <div data-no-swipe className={`absolute left-1/2 -translate-x-1/2 bottom-[max(1rem,env(safe-area-inset-bottom))] md:bottom-auto md:top-4 max-w-[calc(100vw-1.5rem)] bg-black/40 hover:bg-black/80 backdrop-blur-sm shadow-lg text-white rounded-full flex items-center px-2 py-1 gap-1 md:px-4 md:py-2 md:gap-3 z-50 pointer-events-auto transition-colors ${infoOpen ? 'hidden md:flex' : 'flex'}`}>
                                        <button onClick={(e) => { e.stopPropagation(); zoomOut(0.2); }} className="w-11 h-11 md:w-auto md:h-auto flex items-center justify-center shrink-0 hover:text-blue-400 outline-none transition-colors" title="Zoom Out" aria-label="Zoom out">
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                                                <circle cx="11" cy="11" r="8"></circle>
                                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                                <line x1="8" y1="11" x2="14" y2="11"></line>
                                            </svg>
                                        </button>

                                        <input
                                            type="range"
                                            min={0.5}
                                            max={10}
                                            step={0.1}
                                            value={sliderValue}
                                            onChange={(e) => {
                                                e.stopPropagation();
                                                const val = parseFloat(e.target.value);
                                                setSliderValue(val);

                                                if (instance) {
                                                    const { scale: S1, positionX: px, positionY: py } = instance.transformState;
                                                    const S2 = val;

                                                    // Pivot to keep screen center stationary
                                                    const cx = window.innerWidth / 2;
                                                    const cy = window.innerHeight / 2;

                                                    const newX = cx - (cx - px) * (S2 / S1);
                                                    const newY = cy - (cy - py) * (S2 / S1);

                                                    setTransform(newX, newY, S2, 0);
                                                }
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            className="w-28 min-w-0 md:w-32 accent-blue-500 cursor-pointer"
                                            aria-label="Zoom level"
                                        />

                                        <button onClick={(e) => { e.stopPropagation(); zoomIn(0.2); }} className="w-11 h-11 md:w-auto md:h-auto flex items-center justify-center shrink-0 hover:text-blue-400 outline-none transition-colors" title="Zoom In" aria-label="Zoom in">
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                                                <circle cx="11" cy="11" r="8"></circle>
                                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                                <line x1="11" y1="8" x2="11" y2="14"></line>
                                                <line x1="8" y1="11" x2="14" y2="11"></line>
                                            </svg>
                                        </button>
                                    </div>

                                    <div
                                        className="w-full h-full flex items-center justify-center"
                                        onTouchStart={(e) => {
                                            if (zoomScale.current > 1.05) e.stopPropagation();
                                        }}
                                        onTouchMove={(e) => {
                                            if (zoomScale.current > 1.05) e.stopPropagation();
                                        }}
                                        onTouchEnd={(e) => {
                                            if (zoomScale.current > 1.05) e.stopPropagation();
                                        }}
                                    >
                                        <TransformComponent wrapperClass="!w-full !h-full flex items-center justify-center !pointer-events-auto" contentClass="!w-full !h-full flex items-center justify-center">
                                            <img
                                                src={fullResUrl}
                                                alt={item.name}
                                                className="max-w-full max-h-full object-contain pointer-events-auto shadow-2xl transition-all duration-300"
                                                loading="eager"
                                                decoding="async"
                                                fetchPriority="high"
                                            />
                                        </TransformComponent>
                                    </div>
                                </>
                            )}
                        </TransformWrapper>
                    )}
                </div>
            </div>

            {/* Info Panel */}
            <div
                ref={panelRef}
                className={`
                    absolute bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 p-6 pt-2 shadow-[-5px_0_20px_rgba(0,0,0,0.5)] flex flex-col text-left z-20 overflow-y-auto transition-transform duration-300 pointer-events-auto
                    md:top-0 md:right-0 md:h-full md:w-[300px] md:bottom-auto md:left-auto md:rounded-l-2xl md:translate-y-0
                    top-auto right-0 bottom-0 left-0 w-full h-[60vh] rounded-t-3xl md:rounded-t-none
                    ${infoOpen ? 'md:translate-x-0' : 'md:translate-x-full translate-y-full'}
                `}
                style={{
                    // Apply translation for both the open/close state and the current drag offset
                    transform: window.innerWidth < 768
                        ? (infoOpen ? `translateY(${sheetOffset}px)` : 'translateY(100%)')
                        : undefined
                }}
                onTouchStart={handleSheetTouchStart}
                onTouchMove={handleSheetTouchMove}
                onTouchEnd={handleSheetTouchEnd}
            >
                {/* Mobile Drag Handle */}
                <div className="drag-handle-area w-full flex justify-center py-3 md:hidden cursor-grab active:cursor-grabbing pb-4 -mt-2">
                    <div className="w-12 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-full"></div>
                </div>

                <div className="flex justify-between items-start gap-2 mb-6 mt-0">
                    <h3 className="m-0 break-all font-bold text-xl leading-snug">{item.name}</h3>
                    <button
                        className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 transition-colors shrink-0"
                        onClick={() => navigator.clipboard.writeText(item.name)}
                        title="Copy Name"
                        aria-label="Copy name"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                    </button>
                </div>

                <div className="space-y-4">
                    <div className="text-sm flex flex-col">
                        <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-0.5">Size</span>
                        <span className="font-medium text-[15px]">{formatBytes(item.size)}</span>
                    </div>
                    <div className="text-sm flex flex-col">
                        <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-0.5">Type</span>
                        <span className="font-medium text-[15px]">{item.ext.toUpperCase()}</span>
                    </div>
                    {duration && (
                        <div className="text-sm flex flex-col">
                            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-0.5">Duration</span>
                            <span className="font-medium text-[15px]">{duration}</span>
                        </div>
                    )}
                    {rating !== null && (
                        <div className="text-sm flex flex-col">
                            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-0.5">Rating</span>
                            <span className="font-medium text-[15px] text-amber-500" role="img" aria-label={`Rating: ${rating} of ${MAX_RATING}`}>
                                {'★'.repeat(rating)}<span className="text-zinc-300 dark:text-zinc-600">{'★'.repeat(MAX_RATING - rating)}</span>
                            </span>
                        </div>
                    )}
                    {added && (
                        <div className="text-sm flex flex-col">
                            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-0.5">Date Added</span>
                            <span className="font-medium text-[15px]">{added}</span>
                        </div>
                    )}
                    <div className="text-sm flex flex-col">
                        <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-0.5">Modified</span>
                        <span className="font-medium text-[15px]">{modified ?? '—'}</span>
                    </div>
                    <div className="text-sm flex flex-col pt-4 border-t border-zinc-200 dark:border-zinc-800">
                        <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-2">Description</span>
                        <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800/50 p-3 rounded-lg border border-zinc-100 dark:border-zinc-800">
                            {item.description || <em className="text-zinc-400 not-italic">No description provided.</em>}
                        </div>
                    </div>

                    {item.tags && item.tags.length > 0 && (
                        <div className="text-sm flex flex-col pt-4">
                            <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-2">Tags</span>
                            <div className="flex flex-wrap gap-1.5">
                                {item.tags.map(tag => {
                                    const color = tagColor(tag);
                                    return (
                                        <span
                                            key={tag}
                                            className="bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20 px-2 py-1 rounded-md text-xs font-medium cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors"
                                            style={color ? { color, backgroundColor: `${color}1A`, borderColor: `${color}40` } : undefined}
                                            onClick={() => handleTagClick(tag)}
                                        >
                                            #{tag}
                                        </span>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
