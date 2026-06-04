
import React, { useEffect, useState } from 'react';

interface ScanStatus {
    isScanning: boolean;
    scannedCount: number;
    totalItems: number;
}

export const LoadingScreen: React.FC = () => {
    const [status, setStatus] = useState<ScanStatus | null>(null);
    const [isVisible, setIsVisible] = useState(true);

    useEffect(() => {
        let interval: NodeJS.Timeout;

        const checkStatus = async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                setStatus(data);

                if (!data.isScanning && data.totalItems > 0) {
                    // Slight delay to show 100% or completion
                    setTimeout(() => setIsVisible(false), 500);
                } else {
                    setIsVisible(true);
                }
            } catch (e) {
                console.error("Failed to check status", e);
            }
        };

        // Initial check
        checkStatus();

        // Poll
        interval = setInterval(checkStatus, 1000);

        return () => clearInterval(interval);
    }, []);

    if (!isVisible) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: '#1E1E1E', // Dark theme bg
            color: '#fff',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'sans-serif'
        }}>
            <div style={{ marginBottom: '20px', fontSize: '24px', fontWeight: 'bold' }}>
                Library Web Viewer
            </div>

            {status?.isScanning ? (
                <>
                    <div className="spinner" style={{
                        width: '40px',
                        height: '40px',
                        border: '4px solid #333',
                        borderTop: '4px solid #007AFF',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                        marginBottom: '20px'
                    }} />
                    <div style={{ fontSize: '16px', color: '#888' }}>
                        Updating Library... {status.scannedCount} items processed
                    </div>
                    <style>{`
                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }
                    `}</style>
                </>
            ) : (
                <div style={{ fontSize: '16px', color: '#888' }}>
                    Loading...
                </div>
            )}
        </div>
    );
};
