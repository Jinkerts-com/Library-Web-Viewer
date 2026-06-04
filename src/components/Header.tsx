import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '@nanostores/react';
import {
    filtersStore,
    layoutStore,
    themeStore,
    toggleTheme,
    toggleSidebar,
    setSearch,
    setSortBy,
    setSortOrder,
    setLayout,
    toggleTag,
    clearFilters,
    tagsStore,
    zoomLevelStore,
    setZoom,
    type SortOrder,
    type SortBy,
    tagsGroupsStore,
    toggleTagExclude,
    recentColorsStore,
    addRecentColor
} from '../stores/libraryStore';

import LibraryColorPicker from './LibraryColorPicker';

// Icons
const FilterIcon = () => <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"></path></svg>; // Generic
const TagIcon = () => <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M19 5.5h-4.5L9 11l7.5 7.5L22 13l-3-7.5zm-3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM6.5 6h-3A1.5 1.5 0 0 0 2 7.5v8A1.5 1.5 0 0 0 3.5 17h3A1.5 1.5 0 0 0 8 15.5v-8A1.5 1.5 0 0 0 6.5 6z" /></svg>; // Standard Tag
const ColorPaletteIcon = () => (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
        <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
        <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
);


export default function Header() {
    const filters = useStore(filtersStore);
    const layout = useStore(layoutStore);
    const allTags = useStore(tagsStore);
    const tagsGroups = useStore(tagsGroupsStore);
    const zoom = useStore(zoomLevelStore);
    const theme = useStore(themeStore);
    const recentColors = useStore(recentColorsStore);

    const [isTagPopoverOpen, setIsTagPopoverOpen] = useState(false);
    const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false);
    const [isViewOptionsOpen, setIsViewOptionsOpen] = useState(false);
    const [tagSearch, setTagSearch] = useState('');
    const popoverRef = useRef<HTMLDivElement>(null);
    const colorPopoverRef = useRef<HTMLDivElement>(null);

    // Close popover when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsTagPopoverOpen(false);
            }
            if (colorPopoverRef.current && !colorPopoverRef.current.contains(event.target as Node)) {
                setIsColorPopoverOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const filteredTags = allTags.filter(t => t.toLowerCase().includes(tagSearch.toLowerCase()));

    return (
        <header className="w-full h-16 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-700 flex items-center px-4 gap-4 box-border z-20 sticky top-0 justify-between">
            {/* Left: Breadcrumbs / Title (Placeholder for now) */}
            <div className="flex items-center gap-2">
                <button
                    className="md:hidden p-2 -ml-2 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md"
                    onClick={() => toggleSidebar()}
                    title="Toggle Sidebar"
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                </button>
                <span className="hidden md:block text-xl font-bold text-zinc-800 dark:text-zinc-100 truncate">
                    {filters.folderId ? 'Folder View' : 'All Media'}
                </span>
            </div>

            {/* Center: Search & Filters */}
            <div className="flex items-center gap-4 flex-1 justify-center max-w-3xl">
                {/* Icons Bar */}
                <div className="flex items-center gap-2 mr-4">
                    <div className="relative" ref={colorPopoverRef}>
                        <button
                            className={`p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md text-zinc-600 dark:text-zinc-300 ${isColorPopoverOpen || filters.color ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`}
                            title="Colors"
                            onClick={() => setIsColorPopoverOpen(!isColorPopoverOpen)}
                        >
                            {filters.color ? (
                                <span className="w-5 h-5 rounded-full inline-block border border-zinc-300 dark:border-zinc-700" style={{ backgroundColor: filters.color }}></span>
                            ) : (
                                <ColorPaletteIcon />
                            )}
                        </button>

                        {isColorPopoverOpen && (
                            <div className="absolute top-12 left-0 z-50">
                                <LibraryColorPicker
                                    currentColor={filters.color}
                                    accuracy={filters.colorAccuracy}
                                    onSelect={(hex) => {
                                        filtersStore.setKey('color', hex);
                                        if (hex) addRecentColor(hex);
                                    }}
                                    onAccuracyChange={(acc) => {
                                        filtersStore.setKey('colorAccuracy', acc);
                                    }}
                                />
                            </div>
                        )}
                    </div>

                    <div className="relative" ref={popoverRef}>
                        <button
                            className={`p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md text-zinc-600 dark:text-zinc-300 ${isTagPopoverOpen ? 'bg-zinc-200 dark:bg-zinc-800 text-blue-500' : ''}`}
                            title="Tags"
                            onClick={() => setIsTagPopoverOpen(!isTagPopoverOpen)}
                        >
                            <TagIcon />
                        </button>

                        {/* Tag Popover */}
                        {isTagPopoverOpen && (
                            <div className="absolute top-12 left-0 w-64 max-h-[500px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl rounded-lg flex flex-col z-50">
                                <div className="p-2 border-b border-zinc-200 dark:border-zinc-700">
                                    <input
                                        type="text"
                                        placeholder="Search tags..."
                                        className="w-full p-1.5 text-sm bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-zinc-800 dark:text-zinc-100"
                                        value={tagSearch}
                                        onChange={(e) => setTagSearch(e.target.value)}
                                        autoFocus
                                    />
                                </div>
                                <div className="overflow-y-auto flex-1 p-1">
                                    <div
                                        className={`flex items-center gap-2 p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded cursor-pointer ${filters.includedTags.length === 0 ? 'font-bold text-blue-500' : 'text-zinc-700 dark:text-zinc-300'}`}
                                        onClick={() => {
                                            filtersStore.setKey('includedTags', []);
                                            filtersStore.setKey('excludedTags', []);
                                            setIsTagPopoverOpen(false);
                                        }}
                                    >
                                        <span className="text-sm">All Tags ({allTags.length})</span>
                                    </div>

                                    {/* Render Tag Groups */}
                                    {tagsGroups.map(group => {
                                        const groupTags = group.tags.filter(t => t.toLowerCase().includes(tagSearch.toLowerCase()) && allTags.includes(t));
                                        if (groupTags.length === 0) return null;

                                        return (
                                            <div key={group.name} className="mb-2">
                                                <div className="px-2 py-1 text-xs font-bold text-zinc-500 uppercase tracking-wider" style={{ color: group.color }}>{group.name}</div>
                                                {groupTags.map(tag => {
                                                    const isIncluded = filters.includedTags.includes(tag);
                                                    const isExcluded = filters.excludedTags.includes(tag);

                                                    return (
                                                        <div
                                                            key={tag}
                                                            className="flex items-center gap-2 p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded cursor-pointer group"
                                                            onClick={() => toggleTag(tag)}
                                                            onContextMenu={(e) => { e.preventDefault(); toggleTagExclude(tag); }}
                                                        >
                                                            <div className={`w-4 h-4 border rounded flex items-center justify-center ${isIncluded ? 'bg-blue-500 border-blue-500' : isExcluded ? 'bg-red-500 border-red-500' : 'border-zinc-400'}`}>
                                                                {isIncluded && <svg className="w-3 h-3 text-white fill-current" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>}
                                                                {isExcluded && <svg className="w-3 h-3 text-white fill-current" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>}
                                                            </div>
                                                            <span className={`text-sm flex-1 truncate ${isExcluded ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-300'}`}>{tag}</span>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )
                                    })}

                                    {/* Render Other Tags */}
                                    {(() => {
                                        const groupedTagSet = new Set(tagsGroups.flatMap(g => g.tags));
                                        const otherTags = allTags.filter(t => !groupedTagSet.has(t) && t.toLowerCase().includes(tagSearch.toLowerCase()));

                                        if (otherTags.length === 0) return null;

                                        return (
                                            <div className="mb-2">
                                                <div className="px-2 py-1 text-xs font-bold text-zinc-500 uppercase tracking-wider">Other Tags</div>
                                                {otherTags.map(tag => {
                                                    const isIncluded = filters.includedTags.includes(tag);
                                                    const isExcluded = filters.excludedTags.includes(tag);

                                                    return (
                                                        <div
                                                            key={tag}
                                                            className="flex items-center gap-2 p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded cursor-pointer group"
                                                            onClick={() => toggleTag(tag)}
                                                            onContextMenu={(e) => { e.preventDefault(); toggleTagExclude(tag); }}
                                                        >
                                                            <div className={`w-4 h-4 border rounded flex items-center justify-center ${isIncluded ? 'bg-blue-500 border-blue-500' : isExcluded ? 'bg-red-500 border-red-500' : 'border-zinc-400'}`}>
                                                                {isIncluded && <svg className="w-3 h-3 text-white fill-current" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>}
                                                                {isExcluded && <svg className="w-3 h-3 text-white fill-current" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>}
                                                            </div>
                                                            <span className={`text-sm flex-1 truncate ${isExcluded ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-300'}`}>{tag}</span>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        );
                                    })()}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Search Bar */}
                <div className="flex-1 relative">
                    <input
                        type="text"
                        placeholder="Search..."
                        className="w-full py-1.5 pl-9 pr-4 bg-zinc-100 dark:bg-zinc-800 border-none rounded-md text-zinc-800 dark:text-zinc-100 focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-zinc-950 transition-colors"
                        value={filters.search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                </div>
            </div>

            {/* Right: Controls */}
            <div className="flex items-center gap-2 md:gap-3">

                {/* Desktop Controls (Hidden on Mobile) */}
                <div className="hidden md:flex items-center gap-3">
                    {/* Layout Toggle */}
                    <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded p-0.5">
                        <button
                            className={`p-1.5 rounded ${layout === 'masonry' ? 'bg-white dark:bg-zinc-800 shadow-sm text-blue-500' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400'}`}
                            onClick={() => setLayout('masonry')}
                            title="Waterfall"
                        >
                            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M3 6h6v12H3zm8 0h6v6h-6zm0 8h6v4h-6zm8-8h6v4h-6zm0 6h6v6h-6z" opacity="1" /></svg>
                        </button>
                        <button
                            className={`p-1.5 rounded ${layout === 'justified' ? 'bg-white dark:bg-zinc-800 shadow-sm text-blue-500' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400'}`}
                            onClick={() => setLayout('justified')}
                            title="Justified"
                        >
                            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M3 5h18v4H3zm0 6h8v4H3zm10 0h8v4h-8zm-10 6h18v4H3z" /></svg>
                        </button>
                        <button
                            className={`p-1.5 rounded ${layout === 'grid' ? 'bg-white dark:bg-zinc-800 shadow-sm text-blue-500' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400'}`}
                            onClick={() => setLayout('grid')}
                            title="Grid"
                        >
                            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M4 4h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 10h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 16h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4z" /></svg>
                        </button>
                    </div>

                    {/* Zoom Slider */}
                    <div className="flex items-center gap-2 group mx-2">
                        <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <input
                            type="range"
                            min="50"
                            max="350"
                            value={zoom}
                            onChange={(e) => setZoom(parseInt(e.target.value))}
                            className="w-24 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                            title="Zoom"
                        />
                        <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>

                    {/* Sort */}
                    <select
                        value={filters.sortBy}
                        onChange={(e) => setSortBy(e.target.value as SortBy)}
                        className="bg-transparent dark:bg-zinc-900 text-sm font-medium text-zinc-600 dark:text-zinc-300 focus:outline-none cursor-pointer"
                    >
                        <option className="dark:bg-zinc-900" value="modificationTime">Date Modified</option>
                        <option className="dark:bg-zinc-900" value="name">Name</option>
                        <option className="dark:bg-zinc-900" value="size">Size</option>
                    </select>

                    <button
                        onClick={() => setSortOrder(filters.sortOrder === 'asc' ? 'desc' : 'asc')}
                        className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded text-zinc-600 dark:text-zinc-300"
                        title={filters.sortOrder === 'asc' ? 'Ascending' : 'Descending'}
                    >
                        {filters.sortOrder === 'asc' ? (
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 20h18M5 14l7-7 7 7" /></svg>
                        ) : (
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 4h18M5 10l7 7 7-7" /></svg>
                        )}
                    </button>
                </div>

                {/* Mobile View Options Trigger */}
                <div className="md:hidden relative">
                    <button
                        className={`p-2 rounded-md ${isViewOptionsOpen ? 'bg-zinc-200 dark:bg-zinc-800 text-blue-500' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
                        onClick={() => setIsViewOptionsOpen(!isViewOptionsOpen)}
                        title="View Options"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    </button>

                    {/* Popover */}
                    {isViewOptionsOpen && (
                        <>
                            <div className="fixed inset-0 z-40 bg-transparent" onClick={() => setIsViewOptionsOpen(false)}></div>
                            <div className="absolute top-12 right-0 w-64 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl rounded-lg p-4 z-50 flex flex-col gap-4">

                                {/* Layout Section */}
                                <div>
                                    <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-2">Layout</span>
                                    <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded p-1 w-full">
                                        <button className={`flex-1 py-1.5 rounded text-xs font-medium ${layout === 'masonry' ? 'bg-white dark:bg-zinc-800 shadow text-blue-500' : 'text-zinc-600 dark:text-zinc-400'}`} onClick={() => setLayout('masonry')}>Waterfall</button>
                                        <button className={`flex-1 py-1.5 rounded text-xs font-medium ${layout === 'justified' ? 'bg-white dark:bg-zinc-800 shadow text-blue-500' : 'text-zinc-600 dark:text-zinc-400'}`} onClick={() => setLayout('justified')}>Justified</button>
                                        <button className={`flex-1 py-1.5 rounded text-xs font-medium ${layout === 'grid' ? 'bg-white dark:bg-zinc-800 shadow text-blue-500' : 'text-zinc-600 dark:text-zinc-400'}`} onClick={() => setLayout('grid')}>Grid</button>
                                    </div>
                                </div>

                                {/* Zoom Section */}
                                <div>
                                    <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-2">Zoom</span>
                                    <div className="flex items-center gap-3">
                                        <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        <input
                                            type="range"
                                            min="50"
                                            max="350"
                                            value={zoom}
                                            onChange={(e) => setZoom(parseInt(e.target.value))}
                                            className="flex-1 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                        />
                                        <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    </div>
                                </div>

                                {/* Sort Section */}
                                <div>
                                    <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-2">Sort</span>
                                    <div className="flex gap-2">
                                        <select
                                            value={filters.sortBy}
                                            onChange={(e) => setSortBy(e.target.value as SortBy)}
                                            className="flex-1 p-1.5 text-sm bg-zinc-100 dark:bg-zinc-800 border-none rounded text-zinc-700 dark:text-zinc-300"
                                        >
                                            <option value="modificationTime">Date Modified</option>
                                            <option value="name">Name</option>
                                            <option value="size">Size</option>
                                        </select>
                                        <button
                                            onClick={() => setSortOrder(filters.sortOrder === 'asc' ? 'desc' : 'asc')}
                                            className="p-1.5 bg-zinc-100 dark:bg-zinc-800 rounded text-zinc-600 dark:text-zinc-300"
                                        >
                                            {filters.sortOrder === 'asc' ? (
                                                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 20h18M5 14l7-7 7 7" /></svg>
                                            ) : (
                                                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 4h18M5 10l7 7 7-7" /></svg>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* Theme Section */}
                                <div>
                                    <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider block mb-2">Theme</span>
                                    <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded p-1 w-full">
                                        <button
                                            className={`flex-1 py-1.5 rounded text-xs font-medium ${theme === 'light' ? 'bg-white dark:bg-zinc-800 shadow text-blue-500' : 'text-zinc-600 dark:text-zinc-400'}`}
                                            onClick={() => theme !== 'light' && toggleTheme()}
                                        >
                                            Light
                                        </button>
                                        <button
                                            className={`flex-1 py-1.5 rounded text-xs font-medium ${theme === 'dark' ? 'bg-white dark:bg-zinc-800 shadow text-blue-500' : 'text-zinc-600 dark:text-zinc-400'}`}
                                            onClick={() => theme !== 'dark' && toggleTheme()}
                                        >
                                            Dark
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </header>
    );
}
