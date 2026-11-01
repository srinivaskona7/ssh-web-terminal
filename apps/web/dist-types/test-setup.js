import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto || !globalThis.crypto.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        writable: true,
        configurable: true
    });
}
if (typeof window !== 'undefined' && !window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => { },
            removeListener: () => { },
            addEventListener: () => { },
            removeEventListener: () => { },
            dispatchEvent: () => false
        })
    });
}
if (typeof globalThis.ResizeObserver === 'undefined') {
    class MockResizeObserver {
        observe() { }
        unobserve() { }
        disconnect() { }
    }
    globalThis.ResizeObserver = MockResizeObserver;
}
if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext = (() => ({
        fillStyle: '',
        fillRect: () => { },
        clearRect: () => { },
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData: () => { },
        createImageData: () => [],
        setTransform: () => { },
        drawImage: () => { },
        save: () => { },
        fillText: () => { },
        restore: () => { },
        beginPath: () => { },
        moveTo: () => { },
        lineTo: () => { },
        closePath: () => { },
        stroke: () => { },
        translate: () => { },
        scale: () => { },
        rotate: () => { },
        arc: () => { },
        fill: () => { },
        measureText: () => ({ width: 8 }),
        transform: () => { },
        rect: () => { },
        clip: () => { },
        createLinearGradient: () => ({ addColorStop: () => { } })
    }));
}
//# sourceMappingURL=test-setup.js.map