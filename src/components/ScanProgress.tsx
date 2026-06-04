import React, { useEffect, useState } from 'react';

interface ScanStatus {
    isScanning: boolean;
    scannedCount: number;
    totalItems?: number;
}

const ScanProgress: React.FC = () => {
    const [status, setStatus] = useState<ScanStatus | null>(null);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const evtSource = new EventSource('/api/status/stream');

        evtSource.onmessage = (event) => {
            try {
                const data: ScanStatus = JSON.parse(event.data);
                setStatus(data);
                setIsVisible(data.isScanning || false);

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
