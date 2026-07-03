import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Masonry from 'react-masonry-css';
import Modal from './Modal';
import { useStore } from '@nanostores/react';
import { filtersStore, layoutStore, zoomLevelStore, lockedFoldersStore, unlockedFoldersStore, relevantTagsStore, relevantTagCountsStore } from '../stores/libraryStore';
import type { FilterState } from '../stores/libraryStore';
import LockScreen from './LockScreen';

// Client-side fallback when the thumbnail request itself fails; must differ
// from the original URL so onError can't re-request the same failing endpoint.
const FALLBACK_THUMB = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="#e4e4e7"/><circle cx="80" cy="75" r="12" fill="#a1a1aa"/><path d="M55 135l30-35 25 28 15-15 25 22H55z" fill="#a1a1aa"/></svg>'
);

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

interface ImageGridProps {
    initialLayout?: string;
}

export default function ImageGrid({ initialLayout = 'masonry' }: ImageGridProps) {
    const filters = useStore(filtersStore);
    const layout = useStore(layoutStore);
    const rawZoom = useStore(zoomLevelStore);
    const zoom = Math.max(rawZoom || 200, 50);
    const lockedFolders = useStore(lockedFoldersStore);
    const unlockedFolders = useStore(unlockedFoldersStore);
    const isLockedView = !!filters.folderId && lockedFolders.has(filters.folderId) && !unlockedFolders.has(filters.folderId);

    const [items, setItems] = useState<Item[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(true);
    const [selectedItemIndex, setSelectedItemIndex] = useState<number | null>(null);

    // Measured content width, needed to compute justified rows
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        setContainerWidth(el.clientWidth - 32); // minus p-4 padding
        const observer = new ResizeObserver(entries => {
            setContainerWidth(entries[0].contentRect.width);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // unlockedFolders is a dependency so any unlock/re-lock refreshes the
    // current view (locked items appear or vanish immediately, even in "All")
    useEffect(() => {
        setPage(1);
        setItems([]);
        setHasMore(true);
        if (!isLockedView) fetchItems(1, filters);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filters, unlockedFolders]);

    useEffect(() => {
        if (page > 1) {
            fetchItems(page, filters);
        }
    }, [page]);


    const fetchItems = async (pageNum: number, currentFilters: FilterState) => {
        if (loading && pageNum > 1) return;
        setLoading(true);

        try {
            const params = new URLSearchParams({
                page: pageNum.toString(),
                limit: '50',
                sortBy: currentFilters.sortBy || 'modificationTime',
                sortOrder: currentFilters.sortOrder || 'desc',
                ...(currentFilters.search && { search: currentFilters.search }),
                ...(currentFilters.folderId && { folderId: currentFilters.folderId }),
                ...(currentFilters.specialFilter && { specialFilter: currentFilters.specialFilter }),
                ...(currentFilters.color && { color: currentFilters.color }),
                ...(currentFilters.colorAccuracy !== undefined && { colorAccuracy: currentFilters.colorAccuracy.toString() }),
                recursive: currentFilters.recursive ? 'true' : 'false',
            });

            if (currentFilters.includedTags && currentFilters.includedTags.length) {
                params.append('tag', currentFilters.includedTags.join(','));
                if (currentFilters.tagRule === 'any') params.append('tagRule', 'any');
            }
            if (currentFilters.excludedTags && currentFilters.excludedTags.length) params.append('excludedTags', currentFilters.excludedTags.join(','));

            const res = await fetch(`/api/items?${params.toString()}`);
            const data = await res.json();

            const newItems = data.items || [];
            if (newItems.length < 50) setHasMore(false);

            setItems(prev => pageNum === 1 ? newItems : [...prev, ...newItems]);

            // The API reports which tags exist in the current view context
            if (pageNum === 1 && data.relevantTags) {
                relevantTagsStore.set(data.relevantTags);
                relevantTagCountsStore.set(data.relevantTagCounts || null);
            }
        } catch (err) {
            console.error("Failed to fetch items", err);
        } finally {
            setLoading(false);
        }
    };

    const handleObserver = useCallback((entries: IntersectionObserverEntry[]) => {
        const target = entries[0];
        if (target.isIntersecting && !loading && hasMore) {
            setPage(prev => prev + 1);
        }
    }, [loading, hasMore]);

    useEffect(() => {
        const option = {
            root: null,
            rootMargin: "800px",
            threshold: 0.1
        };
        const observer = new IntersectionObserver(handleObserver, option);
        const sentinel = document.getElementById('react-sentinel');
        if (sentinel) observer.observe(sentinel);
        return () => { if (sentinel) observer.unobserve(sentinel); }
    }, [handleObserver]);


    const handleItemClick = (item: Item) => {
        const index = items.findIndex(i => i.id === item.id);
        if (index !== -1) {
            setSelectedItemIndex(index);
        }
    };

    const handleCloseModal = () => setSelectedItemIndex(null);

    const handleNext = () => {
        if (selectedItemIndex !== null && selectedItemIndex < items.length - 1) {
            setSelectedItemIndex(selectedItemIndex + 1);
        }
    };

    const handlePrev = () => {
        if (selectedItemIndex !== null && selectedItemIndex > 0) {
            setSelectedItemIndex(selectedItemIndex - 1);
        }
    };

    const getBreakpointCols = (zoomVal: number) => {
        const targetWidth = zoomVal || 200;
        return {
            default: Math.max(1, Math.floor(1920 / targetWidth)),
            2560: Math.max(1, Math.floor(2560 / targetWidth)),
            1920: Math.max(1, Math.floor(1920 / targetWidth)),
            1600: Math.max(1, Math.floor(1600 / targetWidth)),
            1366: Math.max(1, Math.floor(1366 / targetWidth)),
            1024: Math.max(1, Math.floor(1024 / targetWidth)),
            768: Math.max(1, Math.floor(768 / targetWidth)),
            500: Math.max(1, Math.floor(500 / targetWidth))
        };
    };

    const breakpointColumnsObj = useMemo(() => getBreakpointCols(zoom), [zoom]);

    // Justified layout: pack items into rows at their real aspect ratios, then
    // scale each row's height so it exactly fills the container width (no
    // cropping). Greedy: a row is closed once shrinking it to fit drops the
    // row height to the target or below.
    const JUSTIFIED_GAP = 6;
    const justifiedRows = useMemo(() => {
        if (layout !== 'justified' || !containerWidth) return null;
        const targetHeight = zoom || 200;
        const rows: { items: Item[]; height: number; start: number }[] = [];
        let row: Item[] = [];
        let arSum = 0;
        let start = 0;

        items.forEach((item, i) => {
            const ar = (item.width || 200) / (item.height || 200);
            row.push(item);
            arSum += ar;
            const gaps = (row.length - 1) * JUSTIFIED_GAP;
            const rowHeight = (containerWidth - gaps) / arSum;
            if (rowHeight <= targetHeight) {
                rows.push({ items: row, height: rowHeight, start });
                start = i + 1;
                row = [];
                arSum = 0;
            }
        });

        if (row.length) {
            // Trailing row: keep the target height instead of stretching to fill
            const gaps = (row.length - 1) * JUSTIFIED_GAP;
            rows.push({ items: row, height: Math.min(targetHeight, (containerWidth - gaps) / arSum), start });
        }
        return rows;
    }, [layout, items, containerWidth, zoom]);


    const renderItem = (item: Item, index: number, rowHeight?: number) => {
        const isVideo = ['mp4', 'webm', 'mov'].includes(item.ext.toLowerCase());
        const isAudio = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(item.ext.toLowerCase());
        let thumbUrl = `/api/thumbnail/${item.id}`;

        const style: React.CSSProperties = {};

        if (layout === 'justified') {
            const height = rowHeight ?? (zoom || 200);
            const ar = (item.width || 200) / (item.height || 200);
            style.width = `${ar * height}px`;
            style.height = `${height}px`;
            style.flexShrink = 0;
        }

        const isPriority = index < 10;
        const isHighPriority = index < 4;

        return (
            <div
                key={item.id}
                className={`grid-item group relative overflow-hidden rounded-lg shadow-sm hover:shadow-md cursor-pointer bg-zinc-200 dark:bg-zinc-800 transition-all duration-200 ${layout === 'masonry' ? 'mb-4' : ''}`}
                onClick={() => handleItemClick(item)}
                style={style}
            >
                <div className="absolute inset-0 border-2 border-transparent group-hover:border-blue-500 rounded-lg z-10 pointer-events-none transition-colors"></div>

                <img
                    src={thumbUrl}
                    alt={item.name}
                    width={item.width}
                    height={item.height}
                    className="w-full h-full object-cover block"
                    loading={isPriority ? "eager" : "lazy"}
                    decoding="async"
                    fetchPriority={isHighPriority ? "high" : "auto"}
                    onError={(e) => {
                        e.currentTarget.onerror = null;
                        e.currentTarget.src = FALLBACK_THUMB;
                    }}
                    style={{
                        ...(layout === 'justified' ? { height: '100%', width: '100%', objectFit: 'cover' } : {}),
                        ...(layout === 'masonry' ? { height: 'auto', width: '100%' } : {}),
                        ...(layout === 'grid' ? { aspectRatio: '1/1', width: '100%', objectFit: 'cover' } : {})
                    }}
                />

                {isVideo && (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center pointer-events-none">
                        <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white ml-0.5" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                    </div>
                )}
                {isAudio && (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center pointer-events-none">
                        <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white" aria-hidden="true"><path d="M12 3v9.28a4.39 4.39 0 0 0-1.5-.28 4.5 4.5 0 1 0 4.5 4.5V6h3V3z" /></svg>
                    </div>
                )}

                <div className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white font-medium uppercase opacity-0 group-hover:opacity-100 transition-opacity">
                    {item.ext}
                </div>
            </div>
        );
    };

    return (
        <div ref={containerRef} className="w-full min-h-screen p-4">
            {isLockedView ? (
                <LockScreen folderId={filters.folderId!} />
            ) : items.length === 0 && !loading ? (
                <div className="w-full h-[60vh] flex flex-col items-center justify-center text-zinc-500">
                    <svg className="w-16 h-16 mb-4 text-zinc-300 dark:text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                    </svg>
                    <h3 className="text-xl font-medium text-zinc-700 dark:text-zinc-300 mb-1">No images found</h3>
                    <p className="text-sm">Try adjusting your filters or search terms.</p>
                </div>
            ) : layout === 'justified' ? (
                <div className="flex flex-col" style={{ gap: JUSTIFIED_GAP }}>
                    {justifiedRows?.map(row => (
                        <div key={row.items[0].id} className="flex" style={{ gap: JUSTIFIED_GAP }}>
                            {row.items.map((item, i) => renderItem(item, row.start + i, row.height))}
                        </div>
                    ))}
                </div>
            ) : layout === 'grid' ? (
                <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))` }}
                >
                    {items.map((item, i) => renderItem(item, i))}
                </div>
            ) : (
                <Masonry
                    breakpointCols={breakpointColumnsObj}
                    className="flex w-auto -ml-4"
                    columnClassName="pl-4 bg-clip-padding"
                >
                    {items.map((item, i) => renderItem(item, i))}
                </Masonry>
            )}

            <div id="react-sentinel" className="h-10 w-full flex justify-center items-center mt-4">
                {loading && <div className="border-4 border-zinc-200 border-t-blue-500 rounded-full w-8 h-8 animate-spin" />}
            </div>

            <Modal
                item={selectedItemIndex !== null ? items[selectedItemIndex] : null}
                nextItem={selectedItemIndex !== null && selectedItemIndex < items.length - 1 ? items[selectedItemIndex + 1] : null}
                prevItem={selectedItemIndex !== null && selectedItemIndex > 0 ? items[selectedItemIndex - 1] : null}
                isOpen={selectedItemIndex !== null}
                onClose={handleCloseModal}
                onNext={handleNext}
                onPrev={handlePrev}
                hasNext={selectedItemIndex !== null && selectedItemIndex < items.length - 1}
                hasPrev={selectedItemIndex !== null && selectedItemIndex > 0}
            />
        </div>
    );
}
