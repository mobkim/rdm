import { useCallback, useEffect, useState } from 'react';
import { isCoarsePointer } from './touchInput';

export interface FullscreenViewport { w: number; h: number; top: number; left: number }

const readViewport = (): FullscreenViewport => {
    const vv = window.visualViewport;
    return vv
        ? { w: Math.round(vv.width), h: Math.round(vv.height), top: Math.round(vv.offsetTop), left: Math.round(vv.offsetLeft) }
        : { w: window.innerWidth, h: window.innerHeight, top: 0, left: 0 };
};

/**
 * Fullscreen for a session pane.
 *
 * Desktop: the browser Fullscreen API on the pane's grid cell, as before.
 *
 * Touch devices: iPhone Safari has no Fullscreen API for arbitrary elements, and
 * even where it exists it can't be relied on, so the pane instead pins itself to
 * the viewport ("pseudo" fullscreen) and *also* asks the browser to go truly
 * fullscreen where it can (Android Chrome hides its toolbars; iPad works too).
 * While active, `viewport` tracks the visual viewport, so the pane shrinks above
 * the on-screen keyboard instead of being covered by it.
 */
export function useSessionFullscreen(getCell: () => HTMLElement | null | undefined) {
    const [nativeFs, setNativeFs] = useState(false);
    const [pseudo, setPseudo] = useState(false);
    const [viewport, setViewport] = useState<FullscreenViewport | null>(null);

    useEffect(() => {
        const onChange = () => {
            const active = !!document.fullscreenElement;
            setNativeFs(active);
            // The user backed out of native fullscreen (back gesture / Esc) —
            // drop the pseudo layer too rather than stranding them in it.
            if (!active) setPseudo(false);
        };
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    useEffect(() => {
        if (!pseudo) { setViewport(null); return; }
        const update = () => setViewport(readViewport());
        update();
        const vv = window.visualViewport;
        vv?.addEventListener('resize', update);
        vv?.addEventListener('scroll', update);
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        // Stop the page behind from scrolling/rubber-banding under the pane.
        const prevOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        return () => {
            vv?.removeEventListener('resize', update);
            vv?.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
            document.documentElement.style.overflow = prevOverflow;
        };
    }, [pseudo]);

    const exit = useCallback(() => {
        setPseudo(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        try { screen.orientation?.unlock?.(); } catch { /* unsupported */ }
    }, []);

    const toggle = useCallback(() => {
        if (pseudo || document.fullscreenElement) { exit(); return; }
        if (isCoarsePointer()) {
            setViewport(readViewport());
            setPseudo(true);
            // Best effort: both reject on browsers/contexts that don't allow
            // them, and the pseudo layer already covers the viewport.
            Promise.resolve(document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }))
                .then(() => (screen.orientation as any)?.lock?.('landscape'))
                .catch(() => {});
            return;
        }
        getCell()?.requestFullscreen?.().catch((err) => console.error('Error attempting to enable fullscreen:', err));
    }, [pseudo, exit, getCell]);

    return { isFullscreen: pseudo || nativeFs, pseudo, viewport, toggle, exit };
}
