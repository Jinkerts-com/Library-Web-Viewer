import React, { useState } from 'react';
import { useStore } from '@nanostores/react';
import { eagleColor } from '../lib/eagleColors';
import {
    foldersStore,
    lockedFoldersStore,
    unlockedFoldersStore,
    markFoldersLocked,
    filtersStore,
    setFolderId, // Fixed name
    clearFilters, // Used for "All"
    type Folder,
    sidebarOpenStore,
    setSidebarOpen,
    themeStore,
    toggleTheme,
    toggleRecursive,
    fetchMetadata,
} from '../stores/libraryStore';

// Icons
const CaretIcon = ({ expanded }: { expanded: boolean }) => (
    <svg
        className={`w-4 h-4 fill-current text-zinc-400 dark:text-zinc-500 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        viewBox="0 0 24 24"
        aria-hidden="true"
    >
        <path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"></path>
    </svg>
);

const LockIcon = () => (
    <svg className="w-3.5 h-3.5 fill-current ml-auto opacity-50" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z" />
    </svg>
);

const UnlockedIcon = () => (
    <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18,1C15.24,1 13,3.24 13,6V8H4A2,2 0 0,0 2,10V20A2,2 0 0,0 4,22H16A2,2 0 0,0 18,20V10A2,2 0 0,0 16,8H15V6A3,3 0 0,1 18,3A3,3 0 0,1 21,6V8H23V6C23,3.24 20.76,1 18,1M10,13A2,2 0 0,1 12,15A2,2 0 0,1 10,17A2,2 0 0,1 8,15A2,2 0 0,1 10,13Z" />
    </svg>
);

// My Media Icons
const AllIcon = () => <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>;
const UncategorizedIcon = () => <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" /></svg>;
const UntaggedIcon = () => <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>;
const RandomIcon = () => <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l5 5M4 4l5 5" /></svg>; // Shuffle-like
const TrashIcon = () => <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>;


const FolderItem = ({ folder, depth = 0 }: { folder: Folder, depth?: number }) => {
    const filters = useStore(filtersStore);
    const lockedFolders = useStore(lockedFoldersStore);
    const unlockedFolders = useStore(unlockedFoldersStore);
    const [expanded, setExpanded] = useState(false);

    const isLocked = lockedFolders.has(folder.id) && !unlockedFolders.has(folder.id);
    // Show the re-lock control on the folder that owns the password once it's unlocked
    const isUnlockedRoot = !!folder.hasPassword && lockedFolders.has(folder.id) && unlockedFolders.has(folder.id);
    const isActive = filters.folderId === folder.id;
    const hasChildren = folder.children && folder.children.length > 0;

    const handleToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        setExpanded(!expanded);
    };

    const handleRelock = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            const res = await fetch('/api/lock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderId: folder.id })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                markFoldersLocked(data.lockedIds || [folder.id]);
            }
        } catch (err) {
            console.error('Failed to lock folder', err);
        }
    };

    return (
        <>
            <div
                className={`folder-item flex items-center px-3 py-1.5 mx-2 rounded-md cursor-pointer transition-colors text-sm ${isActive ? 'bg-blue-600 text-white' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'} ${isLocked ? 'opacity-60' : ''}`}
                style={{ paddingLeft: `${depth * 16 + 12}px` }}
                onClick={() => setFolderId(folder.id)}
            >
                <div onClick={hasChildren ? handleToggle : undefined} className={`mr-1 -ml-1 ${hasChildren ? 'cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 rounded' : ''} w-4 h-4 flex items-center justify-center`}>
                    {hasChildren && <CaretIcon expanded={expanded} />}
                </div>
                <svg
                    className={`w-4 h-4 mr-2 shrink-0 ${isActive ? 'fill-white' : eagleColor(folder.iconColor) ? '' : 'fill-blue-400'}`}
                    style={!isActive && eagleColor(folder.iconColor) ? { fill: eagleColor(folder.iconColor)! } : undefined}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                ><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" /></svg>
                <span className="folder-name truncate flex-1">{folder.name}</span>
                {isLocked && <LockIcon />}
                {isUnlockedRoot && (
                    <button
                        className="ml-auto p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 transition-opacity"
                        onClick={handleRelock}
                        title="Lock folder"
                        aria-label="Lock folder"
                    >
                        <UnlockedIcon />
                    </button>
                )}
            </div>
            {hasChildren && expanded && (
                <div>
                    {folder.children.sort((a, b) => a.name.localeCompare(b.name)).map(child => (
                        <FolderItem key={child.id} folder={child} depth={depth + 1} />
                    ))}
                </div>
            )}
        </>
    );
};

export default function Sidebar() {
    const folders = useStore(foldersStore);
    const filters = useStore(filtersStore);
    const isOpen = useStore(sidebarOpenStore);
    const theme = useStore(themeStore); // Use global theme state
    const isDarkMode = theme === 'dark';

    // Initial Data Fetch
    React.useEffect(() => {
        fetchMetadata();
    }, []);

    const handleSpecialFilter = (filter: 'uncategorized' | 'untagged' | 'random' | 'trash' | null) => {
        // Reset basic filters first
        clearFilters();
        // Then apply special
        if (filter) {
            filtersStore.setKey('specialFilter', filter);
        }
    };

    return (
        <>
            <div className={`sidebar fixed md:relative top-0 left-0 h-screen w-64 bg-zinc-50 dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800 z-50 flex flex-col transition-transform duration-300 transform ${isOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 select-none font-sans shrink-0`}>

                {/* Header / Logo */}
                <div className="flex items-center h-16 px-4 shrink-0">
                    <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center mr-3 shadow-lg shadow-blue-500/30">
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    </div>
                    <span className="font-bold text-lg text-zinc-800 dark:text-zinc-100 tracking-tight">Library Viewer</span>
                </div>

                <div className="flex-1 overflow-y-auto py-2 custom-scrollbar">

                    {/* My Media Section */}
                    <div className="mb-6">
                        <div className="px-4 py-2 uppercase text-xs font-bold text-zinc-500 dark:text-zinc-500 tracking-wider mb-1 flex items-center justify-between group cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300">
                            My Media
                            <svg className="w-3 h-3 transition-opacity opacity-0 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                        </div>

                        <div className="space-y-0.5">
                            <div
                                className={`flex items-center px-4 py-2 mx-2 rounded-md cursor-pointer transition-colors text-sm ${!filters.folderId && !filters.specialFilter ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800'}`}
                                onClick={() => clearFilters()}
                            >
                                <AllIcon /><span className="ml-3 font-medium">All</span>
                            </div>

                            <div
                                className={`flex items-center px-4 py-2 mx-2 rounded-md cursor-pointer transition-colors text-sm ${filters.specialFilter === 'uncategorized' ? 'bg-blue-600 text-white' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800'}`}
                                onClick={() => handleSpecialFilter('uncategorized')}
                            >
                                <UncategorizedIcon /><span className="ml-3 font-medium">Uncategorized</span>
                            </div>

                            <div
                                className={`flex items-center px-4 py-2 mx-2 rounded-md cursor-pointer transition-colors text-sm ${filters.specialFilter === 'untagged' ? 'bg-blue-600 text-white' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800'}`}
                                onClick={() => handleSpecialFilter('untagged')}
                            >
                                <UntaggedIcon /><span className="ml-3 font-medium">Untagged</span>
                            </div>

                            <div
                                className={`flex items-center px-4 py-2 mx-2 rounded-md cursor-pointer transition-colors text-sm ${filters.specialFilter === 'random' ? 'bg-blue-600 text-white' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800'}`}
                                onClick={() => handleSpecialFilter('random')}
                            >
                                <RandomIcon /><span className="ml-3 font-medium">Random</span>
                            </div>

                            <div
                                className={`flex items-center px-4 py-2 mx-2 rounded-md cursor-pointer transition-colors text-sm ${filters.specialFilter === 'trash' ? 'bg-blue-600 text-white' : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800'}`}
                                onClick={() => handleSpecialFilter('trash')}
                            >
                                <TrashIcon /><span className="ml-3 font-medium">Trash</span>
                            </div>
                        </div>
                    </div>


                    {/* Folders Section */}
                    <div className="mb-6">
                        <div className="px-4 py-2 uppercase text-xs font-bold text-zinc-500 dark:text-zinc-500 tracking-wider mb-1 flex items-center justify-between">
                            Folders
                        </div>
                        <div className="space-y-0.5">
                            {folders.sort((a, b) => a.name.localeCompare(b.name)).map(folder => (
                                <FolderItem key={folder.id} folder={folder} />
                            ))}
                        </div>
                    </div>
                </div>

                {/* Footer / Theme Toggle */}
                <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 flex flex-col gap-3 bg-zinc-50 dark:bg-zinc-900/50">
                    {/* Recursive Toggle */}
                    <div className="flex items-center gap-2 cursor-pointer" onClick={() => toggleRecursive()}>
                        <div className={`w-4 h-4 border rounded flex items-center justify-center ${filters.recursive ? 'bg-blue-600 border-blue-600' : 'border-zinc-400 bg-white dark:bg-zinc-800'}`}>
                            {filters.recursive && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                        </div>
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Include Subfolders</span>
                    </div>

                    <div className="flex items-center gap-2 cursor-pointer" onClick={toggleTheme}>
                        {isDarkMode ?
                            <svg className="w-5 h-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                            :
                            <svg className="w-5 h-5 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                        }
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{isDarkMode ? 'Light Mode' : 'Dark Mode'}</span>
                    </div>
                </div>
            </div>

            {/* Mobile Overlay */}
            <div
                className={`fixed inset-0 bg-black/50 z-40 transition-opacity md:hidden ${isOpen ? 'block opacity-100' : 'hidden opacity-0'}`}
                onClick={() => setSidebarOpen(false)}
            ></div>
        </>
    );
}
