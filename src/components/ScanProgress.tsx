import React, { useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { isAlertNotice } from '../lib/scanClient';
import { attachScanMonitor, dismissScanNotice, scanStateStore, startLibraryRescan } from '../stores/libraryStore';

// Floating scan feedback. Scan state (event stream, polling fallback, outcomes)
// lives in the shared scan client; this component only renders it, so it is
// visible even when the sidebar is closed on mobile.
const ScanProgress: React.FC = () => {
    const scan = useStore(scanStateStore);

    useEffect(() => attachScanMonitor(), []);

    const notice = scan.notice;
    const isRunning = scan.phase === 'running';
    const isProblem = !!notice && isAlertNotice(notice.kind);

    if (isProblem && notice && !isRunning) {
        return (
            <div role="alert" style={{
                position: 'fixed', bottom: '20px', right: '20px', maxWidth: '360px',
                backgroundColor: 'rgba(120, 20, 20, 0.9)', color: 'white', padding: '12px 16px',
                borderRadius: '8px', zIndex: 9999, fontSize: '13px', display: 'flex', gap: '12px', alignItems: 'flex-start'
            }}>
                <span>
                    {notice.kind === 'failure' ? 'Library scan failed. ' : ''}{notice.message}
                    {notice.kind === 'failure' && (
                        <>
                            {' '}
                            <button type="button" onClick={() => void startLibraryRescan()} disabled={!scan.canStart}
                                style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: scan.canStart ? 'pointer' : 'default', opacity: scan.canStart ? 1 : 0.6, padding: 0, font: 'inherit' }}>
                                {scan.canStart ? 'Retry' : `Retry in ${scan.cooldownSeconds}s`}
                            </button>
                        </>
                    )}
                </span>
                <button type="button" aria-label="Dismiss" onClick={dismissScanNotice}
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '16px' }}>×</button>
            </div>
        );
    }

    if (!isRunning) return null;

    return (
        <div role="status" style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '15px 25px',
            borderRadius: '8px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            backdropFilter: 'blur(5px)'
        }}>
            <div className="spinner" style={{
                width: '16px',
                height: '16px',
                border: '2px solid rgba(255,255,255,0.3)',
                borderRadius: '50%',
                borderTopColor: '#fff',
                animation: 'spin 1s ease-in-out infinite'
            }}></div>
            <div>
                <div style={{ fontWeight: 'bold', fontSize: '14px' }}>Scanning Library...</div>
                <div style={{ fontSize: '12px', opacity: 0.8 }}>
                    Processed: {scan.scannedCount} items{scan.polling ? ' (reconnecting…)' : ''}
                </div>
            </div>
            <style>{`
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
};

export default ScanProgress;
