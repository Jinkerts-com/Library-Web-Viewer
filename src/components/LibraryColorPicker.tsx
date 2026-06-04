import React, { useState, useEffect } from 'react';
import { HexColorPicker } from 'react-colorful';

const PRESET_COLORS = [
    // Row 1
    ['clear', '#333333', '#000000', '#ffffff', '#888888', '#997050', '#c26a8d'],
    // Row 2
    ['#e03131', '#e88c30', '#e3c832', '#3ba86d', '#3e9c9c', '#2c5cb4', '#6442ba']
];

// Reusable SVG for the color wheel icon from the screenshot
const ColorWheelIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="8" stroke="url(#paint0_angular)" strokeWidth="3" />
        <defs>
            <radialGradient id="paint0_angular" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(12 12) rotate(90) scale(8)">
                <stop offset="0" stopColor="#FF0000" />
                <stop offset="0.166667" stopColor="#FF00FF" />
                <stop offset="0.333333" stopColor="#0000FF" />
                <stop offset="0.5" stopColor="#00FFFF" />
                <stop offset="0.666667" stopColor="#00FF00" />
                <stop offset="0.833333" stopColor="#FFFF00" />
                <stop offset="1" stopColor="#FF0000" />
            </radialGradient>
        </defs>
    </svg>
);

interface LibraryColorPickerProps {
    currentColor: string | null;
    accuracy: number;
    onSelect: (hex: string | null) => void;
    onAccuracyChange: (acc: number) => void;
}

export default function LibraryColorPicker({ currentColor, accuracy, onSelect, onAccuracyChange }: LibraryColorPickerProps) {
    const defaultColor = '#05FF05';

    const [localHex, setLocalHex] = useState(currentColor || '');
    const [localAccuracy, setLocalAccuracy] = useState(accuracy);

    // Sync external props to local state if they change outside
    useEffect(() => {
        if (currentColor && currentColor.toLowerCase() !== localHex.toLowerCase()) {
            setLocalHex(currentColor);
        } else if (!currentColor) {
            setLocalHex('');
        }
    }, [currentColor]);

    useEffect(() => {
        setLocalAccuracy(accuracy);
    }, [accuracy]);

    // Debounce Hex Changes
    useEffect(() => {
        const handler = setTimeout(() => {
            if (/^#[0-9A-F]{6}$/i.test(localHex)) {
                if (!currentColor || localHex.toLowerCase() !== currentColor.toLowerCase()) {
                    onSelect(localHex);
                }
            }
        }, 150);
        return () => clearTimeout(handler);
    }, [localHex, currentColor, onSelect]);

    // Debounce Accuracy Changes
    useEffect(() => {
        const handler = setTimeout(() => {
            if (localAccuracy !== accuracy) {
                onAccuracyChange(localAccuracy);
            }
        }, 150);
        return () => clearTimeout(handler);
    }, [localAccuracy, accuracy, onAccuracyChange]);

    const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setLocalHex(val);
        if (val === '') {
            onSelect(null);
        }
    };

    return (
        <div className="flex flex-col gap-4 w-full bg-[#1b1b1b] p-4 rounded-xl shadow-2xl border border-zinc-800" style={{ width: '280px' }}>

            {/* Colorful Square Picker */}
            <div className="library-picker-override relative">
                <HexColorPicker
                    color={localHex || defaultColor}
                    onChange={setLocalHex}
                />
            </div>

            {/* Presets */}
            <div className="flex flex-col gap-2 mt-1">
                {PRESET_COLORS.map((row, i) => (
                    <div key={i} className="flex gap-[6px] justify-between">
                        {row.map(hex => {
                            const isClear = hex === 'clear';
                            const isSelected = currentColor?.toLowerCase() === hex.toLowerCase();

                            return (
                                <button
                                    key={hex}
                                    onClick={() => {
                                        if (isClear) {
                                            setLocalHex('');
                                            onSelect(null);
                                        } else {
                                            setLocalHex(hex);
                                            onSelect(hex);
                                        }
                                    }}
                                    title={isClear ? 'Clear Selection' : hex}
                                    className={`w-7 h-7 rounded-md cursor-pointer overflow-hidden relative transition-transform hover:scale-110 active:scale-95 flex-shrink-0
                                        ${isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-[#1b1b1b]' : 'ring-1 ring-white/10'}`}
                                    style={{ backgroundColor: isClear ? '#3a3a3a' : hex }}
                                >
                                    {isClear && (
                                        <div className="absolute inset-0 m-auto w-full h-full">
                                            {/* Diagonal line to mimic clear icon */}
                                            <div className="absolute w-[140%] h-[1.5px] bg-[#111111] -rotate-45 top-1/2 left-[-20%]"></div>
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                ))}
            </div>

            {/* Hex Input */}
            <div className="flex items-center gap-3 bg-[#111111] border border-zinc-800 rounded-lg p-2.5 mt-1 relative">
                <div
                    className="w-5 h-5 rounded-md shadow-sm border border-zinc-700/50"
                    style={{ backgroundColor: localHex || 'transparent' }}
                />
                <input
                    type="text"
                    value={localHex.toUpperCase()}
                    onChange={handleHexChange}
                    className="bg-transparent text-[#e6e6e6] font-medium tracking-wider text-sm focus:outline-none flex-1 w-full"
                    placeholder="#HEX"
                    maxLength={7}
                />
                <div className="border-l border-zinc-800 pl-3">
                    <ColorWheelIcon />
                </div>
            </div>

            {/* Accuracy Slider */}
            <div className="flex items-center gap-3 pt-2">
                <label className="text-[#a1a1aa] text-sm font-medium">Accuracy:</label>
                <input
                    type="range"
                    min="0"
                    max="150"
                    value={150 - localAccuracy}
                    onChange={(e) => setLocalAccuracy(150 - parseInt(e.target.value))}
                    className="flex-1 h-1.5 bg-[#3a3a3a] rounded-lg appearance-none cursor-pointer"
                />
            </div>

            {/* Styles to exactly mimic the screenshot dimensions/looks for react-colorful */}
            <style>{`
                .library-picker-override .react-colorful {
                    width: 100%;
                    height: 220px;
                }
                .library-picker-override .react-colorful__saturation {
                    border-radius: 4px;
                    border-bottom: 12px solid transparent; 
                }
                .library-picker-override .react-colorful__hue {
                    height: 14px;
                    border-radius: 4px;
                }
                .library-picker-override .react-colorful__pointer {
                    width: 16px;
                    height: 16px;
                    border: 2px solid white;
                    box-shadow: 0 0 4px rgba(0,0,0,0.5);
                }
                
                /* Range slider custom styling */
                input[type=range] {
                    -webkit-appearance: none;
                }
                input[type=range]::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    height: 16px;
                    width: 16px;
                    border-radius: 50%;
                    background: #ffffff;
                    cursor: pointer;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.5);
                }
                input[type=range]::-moz-range-thumb {
                    height: 16px;
                    width: 16px;
                    border-radius: 50%;
                    background: #ffffff;
                    cursor: pointer;
                    border: none;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.5);
                }
            `}</style>
        </div>
    );
}
