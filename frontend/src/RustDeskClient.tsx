import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize, Minimize, RefreshCw, X, GripVertical, Keyboard } from 'lucide-react';
import { writeDeviceClipboard } from './deviceClipboard';
import { OS_ICONS } from './OsIcons';
import { attachSoftKeyboard, attachTouchGestures, createZoomController, SpecialKey, ZoomController } from './touchInput';
import { useSessionFullscreen } from './useSessionFullscreen';

interface Props {
    instanceId: string;
    // The rustdesk sessionId minted by POST /api/connect (named `token` to match
    // GuacamoleClient's prop so App.tsx's render branch can pass either through
    // uniformly).
    token: string;
    name: string;
    ip: string;
    // Bumped by the parent whenever it switches grid layouts, so the cell
    // can be remeasured synchronously in the same commit instead of waiting
    // a frame on the ResizeObserver below — see GuacamoleClient's copy of
    // this prop for the full story.
    layoutVersion?: number;
    // False for the single-view layout — see GuacamoleClient's copy of this
    // prop for the full story.
    fitViewport?: boolean;
    // Single-clicking the header toggles this pane filling the whole main
    // content area in-page — see GuacamoleClient's copy of this prop.
    onToggleMaximize?: () => void;
    os?: '' | 'windows' | 'macos' | 'linux';
    swapCtrlCmd?: boolean;
    // Whether hovering this pane focuses it (default true) — see
    // GuacamoleClient's copy of this prop.
    focusOnHover?: boolean;
    onDisconnect: () => void;
    onRefresh?: () => void;
    onError?: (message: string) => void;
    onReorderDragStart?: (e: React.DragEvent) => void;
    onReorderDragEnd?: () => void;
    clipboard: string;
    onClipboard: (text: string) => void;
}

// message.proto's ControlKey enum (backend/src/rustdesk/proto/message.proto) —
// special keys go over this field; everything else goes as a unicode code point.
const ControlKey = {
    Alt: 1, Backspace: 2, CapsLock: 3, Control: 4, Delete: 5, DownArrow: 6, End: 7,
    Escape: 8, F1: 9, F10: 10, F11: 11, F12: 12, F2: 13, F3: 14, F4: 15, F5: 16,
    F6: 17, F7: 18, F8: 19, F9: 20, Home: 21, LeftArrow: 22, Meta: 23, PageDown: 25,
    PageUp: 26, Return: 27, RightArrow: 28, Shift: 29, Space: 30, Tab: 31, UpArrow: 32,
    Insert: 58,
} as const;

const DOM_KEY_TO_CONTROL_KEY: Record<string, number> = {
    Backspace: ControlKey.Backspace, Tab: ControlKey.Tab, Enter: ControlKey.Return,
    Escape: ControlKey.Escape, ' ': ControlKey.Space, PageUp: ControlKey.PageUp,
    PageDown: ControlKey.PageDown, End: ControlKey.End, Home: ControlKey.Home,
    ArrowLeft: ControlKey.LeftArrow, ArrowUp: ControlKey.UpArrow,
    ArrowRight: ControlKey.RightArrow, ArrowDown: ControlKey.DownArrow,
    Insert: ControlKey.Insert, Delete: ControlKey.Delete, CapsLock: ControlKey.CapsLock,
    F1: ControlKey.F1, F2: ControlKey.F2, F3: ControlKey.F3, F4: ControlKey.F4,
    F5: ControlKey.F5, F6: ControlKey.F6, F7: ControlKey.F7, F8: ControlKey.F8,
    F9: ControlKey.F9, F10: ControlKey.F10, F11: ControlKey.F11, F12: ControlKey.F12,
};
// Control/Alt map straight through by default; swapped (like GuacamoleClient's
// remapKeysym) when the target is macOS and the user wants PC-style shortcut muscle
// memory (Ctrl) to land as Cmd, per swapCtrlCmd.
const CONTROL_OR_ALT: Record<string, number> = { Control: ControlKey.Control, Alt: ControlKey.Alt };

const MOUSE_TYPE_MOVE = 0, MOUSE_TYPE_DOWN = 1, MOUSE_TYPE_UP = 2, MOUSE_TYPE_WHEEL = 3;
const MOUSE_BUTTON_LEFT = 0x01, MOUSE_BUTTON_RIGHT = 0x02, MOUSE_BUTTON_MIDDLE = 0x04;

// RustDesk's CursorData.colors is a raw width*height RGBA bitmap (no PNG/etc framing);
// wrap it in a canvas to get something an <img> can render.
function cursorRgbaToDataUrl(width: number, height: number, base64: string): string | null {
    if (!width || !height || !base64) return null;
    try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        if (bytes.length < width * height * 4) return null;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, width * height * 4), width, height), 0, 0);
        return canvas.toDataURL();
    } catch {
        return null;
    }
}

export const RustDeskClient: React.FC<Props> = ({ token, name, ip, layoutVersion, fitViewport = true, onToggleMaximize, os, swapCtrlCmd, focusOnHover = true, onDisconnect, onRefresh, onError, clipboard, onClipboard, onReorderDragStart, onReorderDragEnd }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const displayRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const cursorImgRef = useRef<HTMLImageElement>(null);
    const cursorCache = useRef<Map<number, { url: string; hotx: number; hoty: number; width: number; height: number }>>(new Map());
    const currentCursorId = useRef<number>(0);
    const cursorPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    // The remote's actual pixel resolution, from PeerInfo — the authoritative source for
    // scaling clicks/moves back to remote coordinates. `el.naturalWidth`/`naturalHeight`
    // (what this used to read) reflects whatever JPEG frame the img last decoded, which is
    // one more asynchronous step removed from "what the remote screen size actually is";
    // relying on it (with a hardcoded 1920x1080 fallback) meant any transient mismatch sent
    // a real absolute mouse_move_to at the wrong scale — the Mac's cursor visibly jumping
    // to a wrong spot for one event, since move (unlike down/up/wheel) is the one mouse
    // event type the remote actually repositions the OS cursor for.
    const displaySize = useRef<{ w: number; h: number }>({ w: 1920, h: 1080 });
    const [status, setStatus] = useState<string>('Connecting...');
    const wsRef = useRef<WebSocket | null>(null);
    const lastClipboard = useRef<string>('');
    const currentObjectUrl = useRef<string | null>(null);
    const onClipboardRef = useRef(onClipboard);
    onClipboardRef.current = onClipboard;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const swapCtrlCmdRef = useRef(swapCtrlCmd);
    swapCtrlCmdRef.current = swapCtrlCmd;
    const fitViewportRef = useRef(fitViewport);
    fitViewportRef.current = fitViewport;
    const wasConnected = useRef(false);
    const failed = useRef(false);
    const fs = useSessionFullscreen(() => rootRef.current?.parentElement);
    const isFullscreen = fs.isFullscreen;
    const fsViewportRef = useRef(fs.pseudo ? fs.viewport : null);
    fsViewportRef.current = fs.pseudo ? fs.viewport : null;
    const zoomRef = useRef<ZoomController | null>(null);
    const zoomLayerRef = useRef<HTMLDivElement>(null);
    const kbRef = useRef<HTMLTextAreaElement>(null);
    const [kbOpen, setKbOpen] = useState(false);
    const [box, setBox] = useState<{ w: number; h: number } | null>(null);

    const measureBox = () => {
        const cell = rootRef.current?.parentElement;
        // Touch "fullscreen" pins the pane to the (visual) viewport — see
        // GuacamoleClient's measureBox.
        const vp = fsViewportRef.current;
        if (!cell && !vp) return;
        const cw = vp ? vp.w : cell!.clientWidth;
        if (cw <= 0) return;
        let w = cw;
        let h = (w * 9) / 16;
        if (vp || fitViewportRef.current) {
            const headerH = headerRef.current?.offsetHeight ?? 0;
            const ch = (vp ? vp.h : cell!.clientHeight) - headerH;
            if (ch <= 0) return;
            if (h > ch) { h = ch; w = (h * 16) / 9; }
        }
        setBox({ w: Math.floor(w), h: Math.floor(h) });
    };

    useEffect(() => {
        const cell = rootRef.current?.parentElement;
        if (!cell) return;
        const ro = new ResizeObserver(measureBox);
        ro.observe(cell);
        measureBox();
        return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // See GuacamoleClient's identical effect: closes the ResizeObserver's
    // one-frame-plus lag to zero for parent-driven grid layout switches,
    // which is what made a big small-to-large jump (e.g. 2x2 -> single view)
    // visibly snap to size late.
    useLayoutEffect(() => {
        measureBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutVersion]);

    // Keep a pinch-zoomed view inside bounds when the pane resizes.
    useLayoutEffect(() => { zoomRef.current?.clamp(); }, [box?.w, box?.h]);

    // Viewport changes (touch fullscreen, rotation, on-screen keyboard).
    useLayoutEffect(() => {
        measureBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fs.pseudo, fs.viewport?.w, fs.viewport?.h]);

    useEffect(() => {
        if (!displayRef.current) return;
        let cleanedUp = false;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const mountPath = window.location.pathname.replace(/[^/]*$/, '');
        const wsBase = import.meta.env.VITE_WS_URL || `${wsProtocol}//${window.location.host}${mountPath}rustdesk-ws`;
        const ws = new WebSocket(`${wsBase}?session=${encodeURIComponent(token)}`);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;
        lastClipboard.current = '';
        cursorCache.current.clear();
        currentCursorId.current = 0;
        cursorPos.current = { x: 0, y: 0 };

        const releaseObjectUrl = () => {
            if (currentObjectUrl.current) {
                URL.revokeObjectURL(currentObjectUrl.current);
                currentObjectUrl.current = null;
            }
        };

        // Positions/sizes the cursor overlay in the <img>'s displayed (post-scaling)
        // coordinate space — mirrors scaleCoords below, just inverted (remote px -> screen px).
        const positionCursor = () => {
            const el = imgRef.current;
            const cursorEl = cursorImgRef.current;
            if (!el || !cursorEl) return;
            const cursor = cursorCache.current.get(currentCursorId.current);
            if (!cursor) {
                cursorEl.style.display = 'none';
                return;
            }
            // Layout size, not getBoundingClientRect: the cursor lives inside
            // the zoom layer, so the zoom transform scales it for us.
            const width = el.offsetWidth, height = el.offsetHeight;
            if (!width || !height) return;
            const scaleX = width / displaySize.current.w;
            const scaleY = height / displaySize.current.h;
            const { x, y } = cursorPos.current;
            cursorEl.style.display = 'block';
            cursorEl.style.width = `${cursor.width * scaleX}px`;
            cursorEl.style.height = `${cursor.height * scaleY}px`;
            cursorEl.style.transform = `translate(${(x - cursor.hotx) * scaleX}px, ${(y - cursor.hoty) * scaleY}px)`;
            if (cursorEl.src !== cursor.url) cursorEl.src = cursor.url;
        };

        ws.onopen = () => setStatus('Waiting...');
        ws.onmessage = (ev) => {
            if (ev.data instanceof ArrayBuffer) {
                const blob = new Blob([ev.data], { type: 'image/jpeg' });
                const url = URL.createObjectURL(blob);
                if (imgRef.current) imgRef.current.src = url;
                releaseObjectUrl();
                currentObjectUrl.current = url;
                if (!wasConnected.current) { wasConnected.current = true; setStatus('Connected'); }
                positionCursor();
                return;
            }
            try {
                const msg = JSON.parse(ev.data as string);
                if (msg.type === 'connected') {
                    wasConnected.current = true;
                    setStatus('Connected');
                    // Cursor position is only ever known locally, from our own mouse
                    // events (see onMouseMove below — the peer excludes whoever's
                    // driving the mouse from its position broadcasts). Left at the
                    // {0,0} default, the cursor renders pinned in the top-left corner
                    // until the user's mouse happens to cross into the video pane —
                    // which reads as "the cursor takes a while to show up". Seeding it
                    // at the display's center on connect gives it a reasonable place to
                    // sit immediately once its shape arrives, even though it won't be
                    // the *real* remote position until the first actual move.
                    const display = msg.peerInfo?.displays?.[0];
                    if (display?.width && display?.height) {
                        displaySize.current = { w: display.width, h: display.height };
                        cursorPos.current = { x: Math.round(display.width / 2), y: Math.round(display.height / 2) };
                        positionCursor();
                    }
                } else if (msg.type === 'clipboard' && typeof msg.text === 'string') {
                    lastClipboard.current = msg.text;
                    onClipboardRef.current(msg.text);
                    void writeDeviceClipboard(msg.text);
                } else if (msg.type === 'cursor-image') {
                    const url = cursorRgbaToDataUrl(Number(msg.width), Number(msg.height), String(msg.rgba ?? ''));
                    if (url) {
                        cursorCache.current.set(Number(msg.id), {
                            url,
                            hotx: Number(msg.hotx ?? 0),
                            hoty: Number(msg.hoty ?? 0),
                            width: Number(msg.width),
                            height: Number(msg.height),
                        });
                        positionCursor();
                    }
                } else if (msg.type === 'cursor-id') {
                    currentCursorId.current = Number(msg.id);
                    positionCursor();
                } else if (msg.type === 'cursor-pos') {
                    cursorPos.current = { x: Number(msg.x ?? 0), y: Number(msg.y ?? 0) };
                    positionCursor();
                } else if (msg.type === 'error') {
                    failed.current = true;
                    setStatus(`Error: ${msg.message}`);
                    onErrorRef.current?.(msg.message || 'the connection failed');
                } else if (msg.type === 'disconnected') {
                    // handled by ws.onclose below
                }
            } catch {
                // ignore malformed control messages
            }
        };
        ws.onerror = () => {
            failed.current = true;
            setStatus('Error: connection failed');
            onErrorRef.current?.('the connection failed');
        };
        ws.onclose = () => {
            setStatus('Disconnected');
            releaseObjectUrl();
            if (cleanedUp) return;
            if (!wasConnected.current && !failed.current) {
                failed.current = true;
                onErrorRef.current?.('the session closed before it opened');
            }
            onDisconnect();
        };

        const send = (obj: unknown) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
        };

        // Mouse: coordinates scaled from the displayed <img> box back to the remote's
        // native pixels (displaySize, from PeerInfo — see the ref's own comment for why
        // not el.naturalWidth). Returns null rather than a guessed {x:0, y:0} when the
        // element isn't laid out yet — callers must skip sending on null, since {0,0}
        // would be a real absolute move command to the screen's top-left corner.
        const scaleCoords = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
            const el = imgRef.current;
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            const scaleX = displaySize.current.w / rect.width;
            const scaleY = displaySize.current.h / rect.height;
            return { x: Math.round((e.clientX - rect.left) * scaleX), y: Math.round((e.clientY - rect.top) * scaleY) };
        };
        const buttonBit = (button: number) => (button === 2 ? MOUSE_BUTTON_RIGHT : button === 1 ? MOUSE_BUTTON_MIDDLE : MOUSE_BUTTON_LEFT);

        // The peer excludes whichever connection most recently sent it mouse input from
        // its CursorPosition broadcasts (an anti-echo optimization: "you already know
        // where you just moved it"). Since we're always the one driving the mouse here,
        // we'd never receive a single cursor-pos message this way — so track position
        // locally from our own input instead, same as RustDesk's own client does.
        const onMouseMove = (e: MouseEvent) => {
            const coords = scaleCoords(e);
            if (!coords) return;
            const { x, y } = coords;
            cursorPos.current = { x, y };
            positionCursor();
            send({ type: 'mouse', mask: MOUSE_TYPE_MOVE, x, y, modifiers: modifiersArray() });
        };
        const onMouseDown = (e: MouseEvent) => {
            e.preventDefault();
            const coords = scaleCoords(e);
            if (!coords) return;
            const { x, y } = coords;
            cursorPos.current = { x, y };
            positionCursor();
            send({ type: 'mouse', mask: MOUSE_TYPE_DOWN | (buttonBit(e.button) << 3), x, y, modifiers: modifiersArray() });
        };
        const onMouseUp = (e: MouseEvent) => {
            const coords = scaleCoords(e);
            if (!coords) return;
            const { x, y } = coords;
            cursorPos.current = { x, y };
            positionCursor();
            send({ type: 'mouse', mask: MOUSE_TYPE_UP | (buttonBit(e.button) << 3), x, y, modifiers: modifiersArray() });
        };
        // Each wheel event sends one scroll "notch" — macOS targets move a
        // shorter distance per notch than Windows/Linux ones do, so they get
        // a bigger step to feel the same (see the matching scrollThreshold
        // tuning in GuacamoleClient).
        const wheelStep = os === 'macos' ? 3 : 1;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            send({ type: 'mouse', mask: MOUSE_TYPE_WHEEL, x: 0, y: e.deltaY > 0 ? -wheelStep : wheelStep, modifiers: modifiersArray() });
        };
        const onContextMenu = (e: MouseEvent) => e.preventDefault();

        const displayEl = displayRef.current;
        displayEl.addEventListener('mousemove', onMouseMove);
        displayEl.addEventListener('mousedown', onMouseDown);
        displayEl.addEventListener('mouseup', onMouseUp);
        displayEl.addEventListener('wheel', onWheel, { passive: false });
        displayEl.addEventListener('contextmenu', onContextMenu);

        // Touch: drive the pointer from gestures (see touchInput.ts). Mouse
        // events are never emitted by touches because the gesture layer
        // preventDefaults them.
        const touchMods = () => modifiersArray();
        const touchMove = (cx: number, cy: number) => {
            const coords = scaleCoords({ clientX: cx, clientY: cy });
            if (!coords) return null;
            cursorPos.current = coords;
            positionCursor();
            return coords;
        };
        // Pinch-zoom is a CSS transform on the zoom layer wrapping the frame
        // and cursor; scaleCoords measures the (transformed) <img>, so mouse
        // mapping stays correct.
        const zoom = createZoomController(displayEl, () => zoomLayerRef.current);
        zoomRef.current = zoom;
        const detachTouch = attachTouchGestures(displayEl, {
            zoom,
            move: (cx, cy) => {
                const c = touchMove(cx, cy);
                if (c) send({ type: 'mouse', mask: MOUSE_TYPE_MOVE, x: c.x, y: c.y, modifiers: touchMods() });
            },
            button: (which, down, cx, cy) => {
                const c = touchMove(cx, cy);
                if (!c) return;
                const bit = which === 'right' ? MOUSE_BUTTON_RIGHT : MOUSE_BUTTON_LEFT;
                send({ type: 'mouse', mask: (down ? MOUSE_TYPE_DOWN : MOUSE_TYPE_UP) | (bit << 3), x: c.x, y: c.y, modifiers: touchMods() });
            },
            scroll: (notches) => {
                // Same sign convention as onWheel above: down = negative.
                for (let i = 0; i < Math.abs(notches); i++) {
                    send({ type: 'mouse', mask: MOUSE_TYPE_WHEEL, x: 0, y: notches > 0 ? -wheelStep : wheelStep, modifiers: touchMods() });
                }
            },
        });

        // Keyboard: focus-gated like GuacamoleClient — only forward while this
        // pane's display element has focus.
        const focusTarget = displayEl;
        const heldControlKeys = new Set<number>();
        const heldUnicode = new Set<number>();

        // Unlike GuacamoleClient's remapKeysym (which swaps Ctrl<->Alt as a documented
        // workaround for Apple's built-in VNC server mishandling Meta/Cmd keysyms —
        // see TigerVNC issue #18), RustDesk talks to its own native agent with proper
        // Meta support (ControlKey.Meta), so the swap here is the literal Ctrl<->Cmd
        // the "swap ctrl/cmd" setting promises, not a VNC-specific workaround.
        const remapCtrlCmd = (domKey: string): string => {
            if (!swapCtrlCmdRef.current) return domKey;
            if (domKey === 'Control') return 'Meta';
            if (domKey === 'Meta') return 'Control';
            return domKey;
        };

        // The Mac's input layer (Enigo, via CGEvent) rebuilds its modifier flag state
        // from KeyEvent.modifiers on *every* event, including a modifier key's own
        // down/up — it doesn't just track state from a bare ControlKey.Shift down
        // event. Self-including the key being sent (for downs) and excluding it (for
        // ups, since heldControlKeys is updated before this runs) mirrors what the
        // real RustDesk client sends and is what makes Shift/Ctrl/Alt/etc register.
        const modifiersArray = () => Array.from(heldControlKeys);

        const onKeyDown = (e: KeyboardEvent) => {
            if (document.activeElement !== focusTarget) return;
            const domKey = remapCtrlCmd(e.key);
            e.preventDefault();
            const special = DOM_KEY_TO_CONTROL_KEY[domKey] ?? CONTROL_OR_ALT[domKey]
                ?? (domKey === 'Meta' ? ControlKey.Meta : domKey === 'Shift' ? ControlKey.Shift : undefined);
            if (special !== undefined) {
                heldControlKeys.add(special);
                send({ type: 'key', down: true, press: false, controlKey: special, modifiers: modifiersArray() });
            } else if (domKey.length === 1) {
                const cp = domKey.codePointAt(0)!;
                heldUnicode.add(cp);
                send({ type: 'key', down: true, press: false, chr: cp, modifiers: modifiersArray() });
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            const domKey = remapCtrlCmd(e.key);
            const special = DOM_KEY_TO_CONTROL_KEY[domKey] ?? CONTROL_OR_ALT[domKey]
                ?? (domKey === 'Meta' ? ControlKey.Meta : domKey === 'Shift' ? ControlKey.Shift : undefined);
            if (special !== undefined && heldControlKeys.has(special)) {
                heldControlKeys.delete(special);
                send({ type: 'key', down: false, press: false, controlKey: special, modifiers: modifiersArray() });
            } else if (domKey.length === 1) {
                const cp = domKey.codePointAt(0)!;
                if (heldUnicode.has(cp)) {
                    heldUnicode.delete(cp);
                    send({ type: 'key', down: false, press: false, chr: cp, modifiers: modifiersArray() });
                }
            }
        };
        const releaseAllKeys = () => {
            for (const k of Array.from(heldControlKeys)) {
                heldControlKeys.delete(k);
                send({ type: 'key', down: false, press: false, controlKey: k, modifiers: modifiersArray() });
            }
            for (const cp of heldUnicode) {
                send({ type: 'key', down: false, press: false, chr: cp, modifiers: modifiersArray() });
            }
            heldUnicode.clear();
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
        focusTarget.addEventListener('blur', releaseAllKeys);
        window.addEventListener('blur', releaseAllKeys);

        // On-screen keyboard: forwards the hidden textarea's output. The document-level
        // key handlers above ignore it since it isn't `focusTarget`.
        const SPECIAL_CONTROL_KEYS: Record<SpecialKey, number> = {
            Backspace: ControlKey.Backspace, Tab: ControlKey.Tab, Enter: ControlKey.Return,
            Escape: ControlKey.Escape, ArrowLeft: ControlKey.LeftArrow, ArrowUp: ControlKey.UpArrow,
            ArrowRight: ControlKey.RightArrow, ArrowDown: ControlKey.DownArrow,
        };
        const detachSoftKeyboard = kbRef.current ? attachSoftKeyboard(kbRef.current, {
            char: (cp) => {
                if (cp === 10) {
                    send({ type: 'key', down: true, press: false, controlKey: ControlKey.Return, modifiers: [] });
                    send({ type: 'key', down: false, press: false, controlKey: ControlKey.Return, modifiers: [] });
                } else if (cp >= 0x20) {
                    send({ type: 'key', down: true, press: false, chr: cp, modifiers: [] });
                    send({ type: 'key', down: false, press: false, chr: cp, modifiers: [] });
                }
            },
            special: (key) => {
                const controlKey = SPECIAL_CONTROL_KEYS[key];
                send({ type: 'key', down: true, press: false, controlKey, modifiers: [] });
                send({ type: 'key', down: false, press: false, controlKey, modifiers: [] });
            },
        }) : () => {};

        return () => {
            cleanedUp = true;
            detachTouch();
            zoom.reset();
            zoomRef.current = null;
            detachSoftKeyboard();
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('keyup', onKeyUp);
            focusTarget.removeEventListener('blur', releaseAllKeys);
            window.removeEventListener('blur', releaseAllKeys);
            displayEl.removeEventListener('mousemove', onMouseMove);
            displayEl.removeEventListener('mousedown', onMouseDown);
            displayEl.removeEventListener('mouseup', onMouseUp);
            displayEl.removeEventListener('wheel', onWheel);
            displayEl.removeEventListener('contextmenu', onContextMenu);
            releaseObjectUrl();
            ws.close();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    // Broadcast: push the shared clipboard into this session when it changes.
    useEffect(() => {
        if (status === 'Connected' && clipboard && clipboard !== lastClipboard.current) {
            lastClipboard.current = clipboard;
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'clipboard', text: clipboard }));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clipboard, status]);

    const toggleFullscreen = fs.toggle;

    // Tapping the toggle button must not steal focus from the hidden textarea.
    const toggleKeyboard = () => {
        const ta = kbRef.current;
        if (!ta) return;
        if (document.activeElement === ta) ta.blur(); else ta.focus({ preventScroll: true });
    };

    // See GuacamoleClient's copy: single-click toggles in-page maximize,
    // held for a beat so a second click (a dblclick, for real fullscreen)
    // can cancel it instead of both firing.
    const headerClickTimer = useRef<number | null>(null);
    const handleHeaderClick = () => {
        if (!onToggleMaximize) return;
        if (headerClickTimer.current !== null) return;
        headerClickTimer.current = window.setTimeout(() => {
            headerClickTimer.current = null;
            onToggleMaximize();
        }, 100);
    };
    const handleHeaderDoubleClick = () => {
        if (headerClickTimer.current !== null) {
            clearTimeout(headerClickTimer.current);
            headerClickTimer.current = null;
        }
        toggleFullscreen();
    };
    useEffect(() => () => {
        if (headerClickTimer.current !== null) clearTimeout(headerClickTimer.current);
    }, []);

    return (
        <div
            ref={rootRef}
            className={`${fs.pseudo ? 'fixed z-[9999] bg-black border-0 rounded-none' : 'relative bg-slate-900 border-2 border-slate-700 rounded-lg'} overflow-hidden flex flex-col group focus-within:border-yellow-400 focus-within:shadow-[0_0_15px_rgba(250,204,21,0.6)] transition-[border-color,box-shadow] duration-150 max-w-full max-h-full [contain:content]`}
            style={fs.pseudo && fs.viewport
                ? { left: fs.viewport.left, top: fs.viewport.top, width: fs.viewport.w, height: fs.viewport.h }
                : box ? { width: box.w } : { width: '100%', height: '100%' }}
            onClick={() => displayRef.current?.focus({ preventScroll: true })}
            onMouseEnter={focusOnHover ? () => displayRef.current?.focus({ preventScroll: true }) : undefined}
        >
            <div ref={headerRef} onClick={handleHeaderClick} onDoubleClick={handleHeaderDoubleClick} className="group/bar bg-slate-800 border-b border-slate-700 px-2 py-1 text-white flex justify-between items-center shrink-0 z-10">
                <span className="flex items-center gap-1.5 truncate">
                    <span
                        draggable
                        onDragStart={(e) => { e.stopPropagation(); onReorderDragStart?.(e); }}
                        onDragEnd={(e) => { e.stopPropagation(); onReorderDragEnd?.(); }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-slate-500 hover:text-slate-300 cursor-grab active:cursor-grabbing shrink-0"
                        title="Drag to reorder"
                    >
                        <GripVertical size={16} />
                    </span>
                    {os && OS_ICONS[os] && (() => {
                        const OsIcon = OS_ICONS[os];
                        return <OsIcon size={14} className="text-slate-500 shrink-0" />;
                    })()}
                    <span className="font-semibold text-sm truncate">{name} {ip && <span className="opacity-60 font-mono text-xs ml-1">{ip}</span>}</span>
                </span>
                <div className="flex gap-4 items-center shrink-0 ml-4 opacity-0 group-hover/bar:opacity-100 touch:opacity-100 transition-opacity">
                    <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => { e.stopPropagation(); toggleKeyboard(); }}
                        className={`touch:inline-flex hidden p-1 -m-1 transition-colors ${kbOpen ? 'text-yellow-300' : 'text-slate-300 hover:text-white'}`}
                        title="Keyboard"
                    >
                        <Keyboard size={18} />
                    </button>
                    {onRefresh && (
                        <button onClick={(e) => { e.stopPropagation(); onRefresh(); }} className="text-slate-300 hover:text-white transition-colors p-1 -m-1" title="Refresh session">
                            <RefreshCw size={16} />
                        </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} className="text-slate-300 hover:text-white transition-colors p-1 -m-1" title="Fullscreen">
                        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onDisconnect(); }} className="text-red-400 hover:text-red-300 transition-colors p-1 -m-1" title="Disconnect">
                        <X size={20} />
                    </button>
                </div>
            </div>

            <div
                ref={displayRef}
                className="relative flex items-center justify-center outline-none cursor-none overflow-hidden bg-black shrink-0 mx-auto my-auto touch-none select-none"
                style={box ? { width: box.w, height: box.h } : { flex: 1, width: '100%' }}
                tabIndex={0}
            >
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <div ref={zoomLayerRef} className="absolute inset-0">
                    <img ref={imgRef} className="w-full h-full" style={{ objectFit: 'fill' }} draggable={false} />
                    {/* eslint-disable-next-line jsx-a11y/alt-text */}
                    <img ref={cursorImgRef} className="absolute top-0 left-0 pointer-events-none select-none" style={{ display: 'none' }} draggable={false} />
                </div>
                {status !== 'Connected' && (
                    <span className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm pointer-events-none">{status}</span>
                )}
            </div>

            {/* Hidden input that summons the OS keyboard on touch devices — see
                GuacamoleClient's copy. */}
            <textarea
                ref={kbRef}
                aria-label="Remote keyboard input"
                className="absolute bottom-0 left-0 w-px h-px opacity-0 pointer-events-none resize-none border-0 p-0"
                style={{ fontSize: 16 }}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                onFocus={() => setKbOpen(true)}
                onBlur={() => setKbOpen(false)}
            />
        </div>
    );
};
