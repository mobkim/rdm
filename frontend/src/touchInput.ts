// Touch + on-screen-keyboard support shared by the RDP/VNC (GuacamoleClient) and
// RustDesk clients. Each client supplies a small set of protocol-specific
// callbacks; the gesture recognition and the hidden-textarea keyboard bridge
// live here so all three protocols behave identically on a phone.

export const isCoarsePointer = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export interface TouchHandlers {
    // Pointer moved to this client-space position.
    move: (clientX: number, clientY: number) => void;
    // A button changed state at this client-space position.
    button: (which: 'left' | 'right', down: boolean, clientX: number, clientY: number) => void;
    // Whole scroll notches; positive scrolls content down (like wheel deltaY > 0).
    scroll: (notches: number) => void;
    // Optional virtual zoom. When given, a two-finger pinch zooms (and pans with
    // the fingers' midpoint), and while zoomed in two-finger drags pan instead
    // of scrolling the remote.
    zoom?: ZoomController;
}

export interface ZoomController {
    isZoomed: () => boolean;
    // ratio: this move's change in finger spacing; (cx, cy): current midpoint in
    // client space; (dx, dy): how far the midpoint moved since the last call.
    pinch: (cx: number, cy: number, ratio: number, dx: number, dy: number) => void;
    // Re-fit pan limits after the container changes size.
    clamp: () => void;
    reset: () => void;
}

const MAX_ZOOM = 4;

/**
 * Virtual zoom: scales/pans `getTarget()` with a CSS transform inside
 * `container` (which should clip overflow). Because the transform is on the
 * element itself, getBoundingClientRect() on it already reflects the zoom, so
 * client->remote coordinate mapping that measures that element stays correct.
 */
export function createZoomController(container: HTMLElement, getTarget: () => HTMLElement | null | undefined): ZoomController {
    let z = 1, tx = 0, ty = 0;
    const apply = () => {
        const el = getTarget();
        if (!el) return;
        el.style.transformOrigin = '0 0';
        el.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
        el.style.willChange = z === 1 ? '' : 'transform';
    };
    const clamp = () => {
        const w = container.clientWidth, h = container.clientHeight;
        tx = Math.min(0, Math.max(w * (1 - z), tx));
        ty = Math.min(0, Math.max(h * (1 - z), ty));
        if (z === 1) { tx = 0; ty = 0; }
        apply();
    };
    return {
        isZoomed: () => z > 1,
        pinch: (cx, cy, ratio, dx, dy) => {
            const r = container.getBoundingClientRect();
            const fx = cx - r.left, fy = cy - r.top;
            const nz = Math.min(MAX_ZOOM, Math.max(1, z * ratio));
            // Keep the content point under the fingers fixed, then follow the midpoint.
            const px = (fx - tx) / z, py = (fy - ty) / z;
            tx = fx - px * nz + dx;
            ty = fy - py * nz + dy;
            // Snap to 1x when pinched (almost) all the way out.
            z = nz < 1.03 ? 1 : nz;
            clamp();
        },
        clamp,
        reset: () => { z = 1; tx = 0; ty = 0; apply(); },
    };
}

const MOVE_SLOP = 8;          // px a finger may wander before a tap becomes a drag
const LONG_PRESS_MS = 500;    // hold to right-click
const TWO_FINGER_TAP_MS = 300;
const SCROLL_PX_PER_NOTCH = 24;
const PINCH_SLOP = 12;        // px of finger-spacing change before two fingers count as a pinch

/**
 * Direct-touch gestures:
 *   tap              left click          (two quick taps = double click)
 *   long press       right click
 *   one-finger drag  left-button drag    (move windows, select text)
 *   two-finger drag  scroll
 *   two-finger tap   right click
 */
export function attachTouchGestures(el: HTMLElement, h: TouchHandlers): () => void {
    type Mode = 'idle' | 'pending' | 'drag' | 'longpress' | 'scroll';
    let pinching = false, startDist = 0, lastDist = 0, lastCx = 0, lastCy = 0;
    let mode: Mode = 'idle';
    let startX = 0, startY = 0;
    let lastX = 0, lastY = 0;
    let longPressTimer: number | null = null;
    let scrollY = 0, scrollAccum = 0, scrollTotal = 0, scrollStart = 0;

    const clearTimer = () => {
        if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
    };
    const spacing = (e: TouchEvent) =>
        Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const centroid = (e: TouchEvent) => {
        let x = 0, y = 0;
        for (let i = 0; i < e.touches.length; i++) { x += e.touches[i].clientX; y += e.touches[i].clientY; }
        return { x: x / e.touches.length, y: y / e.touches.length };
    };

    const onStart = (e: TouchEvent) => {
        e.preventDefault(); // also suppresses the emulated mouse events
        clearTimer();
        if (e.touches.length === 1) {
            const t = e.touches[0];
            startX = lastX = t.clientX;
            startY = lastY = t.clientY;
            mode = 'pending';
            h.move(startX, startY);
            longPressTimer = window.setTimeout(() => {
                longPressTimer = null;
                if (mode !== 'pending') return;
                mode = 'longpress';
                navigator.vibrate?.(15);
                h.button('right', true, startX, startY);
                h.button('right', false, startX, startY);
            }, LONG_PRESS_MS);
        } else if (e.touches.length === 2) {
            if (mode === 'drag') h.button('left', false, lastX, lastY);
            mode = 'scroll';
            const c = centroid(e);
            scrollY = c.y;
            lastCx = c.x; lastCy = c.y;
            startDist = lastDist = spacing(e);
            pinching = false;
            scrollAccum = 0;
            scrollTotal = 0;
            scrollStart = Date.now();
        }
    };

    const onMove = (e: TouchEvent) => {
        e.preventDefault();
        if (mode === 'scroll' && e.touches.length >= 2) {
            const c = centroid(e);
            if (h.zoom) {
                const dist = spacing(e);
                if (!pinching && Math.abs(dist - startDist) > PINCH_SLOP) pinching = true;
                if (pinching || h.zoom.isZoomed()) {
                    h.zoom.pinch(c.x, c.y, pinching && lastDist > 0 ? dist / lastDist : 1, c.x - lastCx, c.y - lastCy);
                    scrollTotal += Math.abs(dist - lastDist) + Math.abs(c.y - lastCy) + Math.abs(c.x - lastCx);
                    lastDist = dist; lastCx = c.x; lastCy = c.y; scrollY = c.y;
                    return;
                }
                lastDist = dist; lastCx = c.x; lastCy = c.y;
            }
            // Fingers moving up => content moves down => scroll down (positive).
            const delta = scrollY - c.y;
            scrollY = c.y;
            scrollTotal += Math.abs(delta);
            scrollAccum += delta;
            const notches = Math.trunc(scrollAccum / SCROLL_PX_PER_NOTCH);
            if (notches !== 0) {
                scrollAccum -= notches * SCROLL_PX_PER_NOTCH;
                h.scroll(notches);
            }
            return;
        }
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        lastX = t.clientX;
        lastY = t.clientY;
        if (mode === 'pending') {
            if (Math.hypot(lastX - startX, lastY - startY) < MOVE_SLOP) return;
            clearTimer();
            mode = 'drag';
            h.button('left', true, startX, startY);
        }
        if (mode === 'drag') h.move(lastX, lastY);
    };

    const onEnd = (e: TouchEvent) => {
        e.preventDefault();
        clearTimer();
        if (mode === 'scroll') {
            // Fingers lift one at a time; settle the gesture once both are up.
            if (e.touches.length > 0) return;
            if (scrollTotal < MOVE_SLOP && Date.now() - scrollStart < TWO_FINGER_TAP_MS) {
                h.button('right', true, startX, startY);
                h.button('right', false, startX, startY);
            }
        } else if (mode === 'pending') {
            h.button('left', true, startX, startY);
            h.button('left', false, startX, startY);
        } else if (mode === 'drag') {
            h.button('left', false, lastX, lastY);
        }
        if (e.touches.length === 0) mode = 'idle';
    };

    const onCancel = () => {
        clearTimer();
        if (mode === 'drag') h.button('left', false, lastX, lastY);
        mode = 'idle';
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onCancel);
    return () => {
        clearTimer();
        el.removeEventListener('touchstart', onStart);
        el.removeEventListener('touchmove', onMove);
        el.removeEventListener('touchend', onEnd);
        el.removeEventListener('touchcancel', onCancel);
    };
}

export type SpecialKey =
    'Backspace' | 'Enter' | 'Tab' | 'Escape' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export interface SoftKeyboardHandlers {
    // Type one unicode code point (press + release).
    char: (codePoint: number) => void;
    // Tap a non-printing key (press + release).
    special: (key: SpecialKey) => void;
}

const BASELINE = '    ';
const KEYDOWN_SPECIALS: Record<string, SpecialKey> = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
};

/**
 * Bridges a (visually hidden) <textarea> to key events so the OS keyboard can
 * be summoned and its output forwarded to the remote.
 *
 * Mobile keyboards mostly don't produce usable keydown events (Android reports
 * key "Unidentified"/keyCode 229, and IMEs compose text), so instead this diffs
 * the textarea's contents after every `input` event: removed characters become
 * Backspaces, added ones become typed characters. The textarea is kept primed
 * with a short baseline so Backspace always has something to delete.
 */
export function attachSoftKeyboard(ta: HTMLTextAreaElement, h: SoftKeyboardHandlers): () => void {
    let prev = BASELINE;
    let composing = false;

    const reset = () => { ta.value = BASELINE; prev = BASELINE; ta.setSelectionRange(BASELINE.length, BASELINE.length); };
    reset();

    const sync = () => {
        const cur = ta.value;
        let i = 0;
        while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
        for (let n = prev.length - i; n > 0; n--) h.special('Backspace');
        for (const ch of cur.slice(i)) h.char(ch.codePointAt(0)!);
        prev = cur;
        if (!composing && cur !== BASELINE) reset();
    };

    const onInput = () => sync();
    const onCompStart = () => { composing = true; };
    const onCompEnd = () => { composing = false; sync(); };
    const onKeyDown = (e: KeyboardEvent) => {
        const special = KEYDOWN_SPECIALS[e.key];
        if (special && !composing) {
            e.preventDefault();
            h.special(special);
        }
    };
    // Keep the caret at the end so cursor-dragging in the keyboard can't desync the diff.
    const onSelect = () => {
        if (ta.selectionStart !== ta.value.length || ta.selectionEnd !== ta.value.length) {
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    };

    ta.addEventListener('input', onInput);
    ta.addEventListener('compositionstart', onCompStart);
    ta.addEventListener('compositionend', onCompEnd);
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('select', onSelect);
    return () => {
        ta.removeEventListener('input', onInput);
        ta.removeEventListener('compositionstart', onCompStart);
        ta.removeEventListener('compositionend', onCompEnd);
        ta.removeEventListener('keydown', onKeyDown);
        ta.removeEventListener('select', onSelect);
    };
}
