import React, { useEffect, useRef, useState } from 'react';

interface ScanStatus {
    isScanning: boolean;
    scannedCount: number;
    totalItems?: number;
    // Terminal fields (additive; absent on progress messages and from older servers)
    outcome?: 'success' | 'partial' | 'failure' | null;
    error?: string | null;
}

const ScanProgress: React.FC = () => {
    const [status, setStatus] = useState<ScanStatus | null>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const isFirstMessage = useRef(true);

    useEffect(() => {
        const evtSource = new EventSource('/api/status/stream');

        evtSource.onmessage = (event) => {
            try {
                const data: ScanStatus = JSON.parse(event.data);
                setStatus(data);
                setIsVisible(data.isScanning || false);

                // A scan that finished while we were watching and did not fully succeed.
                // The first message is just the server's snapshot, not news.
                if (data.isScanning) {
                    setNotice(null);
                } else if (!isFirstMessage.current && (data.outcome === 'failure' || data.outcome === 'partial')) {
                    setNotice((data.outcome === 'failure' ? 'Library scan failed. ' : 'Library scan finished with problems. ') + (data.error || ''));
                }
                isFirstMessage.current = false;

            } catch (e) {
                console.error("Failed to parse SSE", e);
            }
        };

        evtSource.onerror = (err) => {
        };

        return () => {
            evtSource.close();
        };
    }, []);

    if (notice && !isVisible) {
        return (
            <div role="alert" style={{
                position: 'fixed', bottom: '20px', right: '20px', maxWidth: '360px',
                backgroundColor: 'rgba(120, 20, 20, 0.9)', color: 'white', padding: '12px 16px',
                borderRadius: '8px', zIndex: 9999, fontSize: '13px', display: 'flex', gap: '12px', alignItems: 'flex-start'
            }}>
                <span>{notice}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '16px' }}>×</button>
            </div>
        );
    }

    if (!isVisible || !status) return null;

    return (
        <div style={{
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
                    Processed: {status.scannedCount} items
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
