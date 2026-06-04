import React, { useEffect, useState, useRef } from 'react';
import { filtersStore } from '../stores/libraryStore';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

interface Item {
    id: string;
    name: string;
    ext: string;
    width: number;
    height: number;
    size: number;
    modificationTime: number;
    description?: string;
    tags?: string[];
}

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
}

export default function Modal({ item, nextItem, prevItem, isOpen, onClose, onNext, onPrev, hasNext, hasPrev }: ModalProps) {
    const [infoOpen, setInfoOpen] = useState(false);
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

    if (!isOpen || !item) return null;

    const getOriginalUrl = (itm: Item) => `/images/${itm.id}.info/${itm.name}.${itm.ext}`;

    const getFullResUrl = (itm: Item) => {
        const supportedRenderExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'];
        if (supportedRenderExts.includes(itm.ext.toLowerCase())) {
            return getOriginalUrl(itm);
        }
        return `/api/preview/${itm.id}`;
    };

    const isVideo = ['mp4', 'webm', 'mov'].includes(item.ext.toLowerCase());
    const isAudio = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(item.ext.toLowerCase());
    const fullResUrl = isVideo || isAudio ? getOriginalUrl(item) : getFullResUrl(item);

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

        // Only track single touch points
        if (e.touches.length === 1 && zoomScale.current <= 1.05) {
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

    return (
        <div
            className="fixed inset-0 z-[3000] w-full h-full bg-black/85 dark:bg-black/95 overflow-hidden font-sans"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
        >
            {/* Preload Next/Prev Images */}
            <div style={{ display: 'none' }}>
                {nextItem && !['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(nextItem.ext.toLowerCase()) && (
                    <img src={getFullResUrl(nextItem)} alt="preload next" />
                )}
                {prevItem && !['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(prevItem.ext.toLowerCase()) && (
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
                <div
                    className={`absolute top-1/2 left-4 -translate-y-1/2 text-3xl text-white cursor-pointer select-none bg-black/40 hover:bg-black/80 rounded-full transition-colors z-10 flex items-center justify-center w-12 h-12 shadow-lg backdrop-blur-sm ${!hasPrev ? 'opacity-20 cursor-default pointer-events-none' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onPrev(); }}
                >
                    &#10094;
                </div>
                <div
                    className={`absolute top-1/2 right-4 -translate-y-1/2 text-3xl text-white cursor-pointer select-none bg-black/40 hover:bg-black/80 rounded-full transition-colors z-10 flex items-center justify-center w-12 h-12 shadow-lg backdrop-blur-sm ${!hasNext ? 'opacity-20 cursor-default pointer-events-none' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onNext(); }}
                >
                    &#10095;
                </div>

                {/* Top Controls */}
                <button
                    className={`absolute top-4 right-16 bg-black/40 hover:bg-black/80 text-white rounded-full w-10 h-10 cursor-pointer z-50 font-bold flex items-center justify-center transition-colors shadow-lg backdrop-blur-sm pointer-events-auto ${infoOpen ? 'bg-black/80 text-blue-400' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setInfoOpen(!infoOpen); }}
                    title="Toggle Info"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </button>
                <div
                    className="absolute top-4 right-4 text-white hover:text-red-400 bg-black/40 hover:bg-black/80 w-10 h-10 rounded-full flex items-center justify-center cursor-pointer z-50 transition-colors shadow-lg backdrop-blur-sm"
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    title="Close"
                >
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>
                </div>

                {/* Media Wrapper */}
                <div
                    className="w-full h-full flex items-center justify-center p-4 sm:p-12 pointer-events-none"
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
                                src={`/api/thumbnail/${item.id}`}
                                className="max-w-[500px] max-h-[500px] mb-10 object-contain rounded-lg shadow-2xl"
                                alt="Cover"
                                loading="eager"
                                decoding="async"
                                // @ts-ignore
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
                            {({ state, instance, zoomIn, zoomOut, setTransform, centerView }: any) => (
                                <>
                                    {/* Zoom Controls */}
                                    <div className={`absolute top-4 left-1/2 -translate-x-1/2 bg-black/40 hover:bg-black/80 backdrop-blur-sm shadow-lg text-white rounded-full flex items-center px-4 py-2 gap-3 z-50 pointer-events-auto transition-colors ${infoOpen ? 'hidden md:flex' : 'flex'}`}>
                                        <button onClick={(e) => { e.stopPropagation(); zoomOut(0.2); }} className="hover:text-blue-400 outline-none transition-colors" title="Zoom Out">
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
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
                                            className="w-24 md:w-32 accent-blue-500 cursor-pointer"
                                        />

                                        <button onClick={(e) => { e.stopPropagation(); zoomIn(0.2); }} className="hover:text-blue-400 outline-none transition-colors" title="Zoom In">
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
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
                                            if ((state?.scale || 1) > 1.05) e.stopPropagation();
                                        }}
                                        onTouchMove={(e) => {
                                            if ((state?.scale || 1) > 1.05) e.stopPropagation();
                                        }}
                                        onTouchEnd={(e) => {
                                            if ((state?.scale || 1) > 1.05) e.stopPropagation();
                                        }}
                                    >
                                        <TransformComponent wrapperClass="!w-full !h-full flex items-center justify-center !pointer-events-auto" contentClass="!w-full !h-full flex items-center justify-center">
                                            <img
                                                src={fullResUrl}
                                                alt={item.name}
                                                className="max-w-full max-h-full object-contain pointer-events-auto shadow-2xl transition-all duration-300"
                                                loading="eager"
                                                decoding="async"
                                                // @ts-ignore
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
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
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
                    <div className="text-sm flex flex-col">
                        <span className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-0.5">Created</span>
                        <span className="font-medium text-[15px]">{new Date(item.modificationTime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
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
                                {item.tags.map(tag => (
                                    <span
                                        key={tag}
                                        className="bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20 px-2 py-1 rounded-md text-xs font-medium cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors"
                                        onClick={() => handleTagClick(tag)}
                                    >
                                        #{tag}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
