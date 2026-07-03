import React, { useState } from 'react';
import { useStore } from '@nanostores/react';
import { foldersStore, markFoldersUnlocked, type Folder } from '../stores/libraryStore';

function findFolderPath(folders: Folder[], id: string, trail: Folder[] = []): Folder[] | null {
    for (const folder of folders) {
        const next = [...trail, folder];
        if (folder.id === id) return next;
        if (folder.children) {
            const found = findFolderPath(folder.children, id, next);
            if (found) return found;
        }
    }
    return null;
}

export default function LockScreen({ folderId }: { folderId: string }) {
    const folders = useStore(foldersStore);
    const [password, setPassword] = useState('');
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);

    // The password lives on the nearest self-or-ancestor folder that has one;
    // locks cascade down from it
    const path = findFolderPath(folders, folderId) || [];
    const protectedFolder = [...path].reverse().find(f => f.hasPassword);
    const hint = protectedFolder?.passwordTips;

    const submit = async () => {
        if (!protectedFolder || !password || busy) return;
        setBusy(true);
        setError(false);
        try {
            const res = await fetch('/api/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderId: protectedFolder.id, password })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                markFoldersUnlocked(data.unlockedIds || [protectedFolder.id]);
            } else {
                setError(true);
                setPassword('');
            }
        } catch (e) {
            setError(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="w-full h-[70vh] flex flex-col items-center justify-center text-center px-4">
            <svg className="w-20 h-20 mb-6 text-zinc-300 dark:text-zinc-700" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3M12,17A2,2 0 0,0 14,15A2,2 0 0,0 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17Z" />
            </svg>
            <h3 className="text-xl font-bold text-zinc-800 dark:text-zinc-100 mb-2">Unlock to view Contents</h3>
            {hint && <p className="text-sm text-zinc-500 mb-5">Hint: {hint}</p>}
            <input
                type="password"
                placeholder="Enter Password"
                aria-label="Folder password"
                autoFocus
                value={password}
                disabled={busy}
                onChange={(e) => { setPassword(e.target.value); setError(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                className={`w-64 px-4 py-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 border focus:outline-none focus:ring-2 transition-colors ${error ? 'border-red-500 focus:ring-red-500' : 'border-zinc-300 dark:border-zinc-700 focus:ring-blue-500'}`}
            />
            {error && <p className="text-sm text-red-500 mt-3">Incorrect password. Try again.</p>}
        </div>
    );
}
