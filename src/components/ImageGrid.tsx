import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Masonry from 'react-masonry-css';
import Modal from './Modal';
import { useStore } from '@nanostores/react';
import { filtersStore, layoutStore, toggleSidebar, zoomLevelStore } from '../stores/libraryStore';

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

    const [items, setItems] = useState<Item[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(true);
    const [selectedItemIndex, setSelectedItemIndex] = useState<number | null>(null);

    useEffect(() => {
        setPage(1);
        setItems([]);
        setHasMore(true);
        fetchItems(1, filters);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filters]);

    useEffect(() => {
        if (page > 1) {
            fetchItems(page, filters);
        }
    }, [page]);


    const fetchItems = async (pageNum: number, currentFilters: any) => {
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

            if (currentFilters.includedTags && currentFilters.includedTags.length) params.append('tag', currentFilters.includedTags.join(','));
            if (currentFilters.excludedTags && currentFilters.excludedTags.length) params.append('excludedTags', currentFilters.excludedTags.join(','));

            const res = await fetch(`/api/items?${params.toString()}`);
            const data = await res.json();

            const newItems = data.items || [];
            if (newItems.length < 50) setHasMore(false);

            setItems(prev => pageNum === 1 ? newItems : [...prev, ...newItems]);
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


    const renderItem = (item: Item, index: number) => {
        const isVideo = ['mp4', 'webm', 'mov'].includes(item.ext.toLowerCase());
        const isAudio = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(item.ext.toLowerCase());
        let thumbUrl = `/api/thumbnail/${item.id}`;

        const style: React.CSSProperties = {};

        if (layout === 'justified') {
            const targetHeight = zoom || 200;
            const ar = (item.width || 200) / (item.height || 200);
            style.width = `${ar * targetHeight}px`;
            style.flexGrow = ar;
            style.height = `${targetHeight}px`;
        }

        const isPriority = index < 10;
        const isHighPriority = index < 4;

        return (
            <div
                key={item.id}
                className={`grid-item group relative overflow-hidden rounded-lg shadow-sm hover:shadow-md cursor-pointer bg-zinc-200 dark:bg-zinc-800 transition-all duration-200 ${layout === 'grid' ? '' : 'mb-4'}`}
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
                    // @ts-ignore
                    fetchPriority={isHighPriority ? "high" : "auto"}
                    onError={(e) => {
                        e.currentTarget.src = `/api/thumbnail/${item.id}`;
                    }}
                    style={{
                        ...(layout === 'justified' ? { height: '100%', width: '100%', objectFit: 'cover' } : {}),
                        ...(layout === 'masonry' ? { height: 'auto', width: '100%' } : {}),
                        ...(layout === 'grid' ? { aspectRatio: '1/1', width: '100%', objectFit: 'cover' } : {})
                    }}
                />

                {isVideo && (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center pointer-events-none">
                        <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white ml-0.5"><path d="M8 5v14l11-7z" /></svg>
                    </div>
                )}
                {isAudio && (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center pointer-events-none">
                        <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white"><path d="M12 3v9.28a4.39 4.39 0 0 0-1.5-.28 4.5 4.5 0 1 0 4.5 4.5V6h3V3z" /></svg>
                    </div>
                )}

                <div className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white font-medium uppercase opacity-0 group-hover:opacity-100 transition-opacity">
                    {item.ext}
                </div>
            </div>
        );
    };

    return (
        <div className="w-full min-h-screen p-4">
            {items.length === 0 && !loading ? (
                <div className="w-full h-[60vh] flex flex-col items-center justify-center text-zinc-500">
                    <svg className="w-16 h-16 mb-4 text-zinc-300 dark:text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                    </svg>
                    <h3 className="text-xl font-medium text-zinc-700 dark:text-zinc-300 mb-1">No images found</h3>
                    <p className="text-sm">Try adjusting your filters or search terms.</p>
                </div>
            ) : layout === 'justified' ? (
                <div className="flex flex-wrap gap-1.5 after:grow-[999999999] after:content-['']">
                    {items.map(renderItem)}
                </div>
            ) : layout === 'grid' ? (
                <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))` }}
                >
                    {items.map(renderItem)}
                </div>
            ) : (
                <Masonry
                    breakpointCols={breakpointColumnsObj}
                    className="flex w-auto -ml-4"
                    columnClassName="pl-4 bg-clip-padding"
                >
                    {items.map(renderItem)}
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
