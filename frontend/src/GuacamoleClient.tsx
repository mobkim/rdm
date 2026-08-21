import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize, Minimize, RefreshCw, X, GripVertical } from 'lucide-react';
import Guacamole from 'guacamole-common-js';
import { writeDeviceClipboard } from './deviceClipboard';
import { OS_ICONS } from './OsIcons';

interface Props {
    instanceId: string;
    token: string;
    name: string;
    ip: string;
    // Bumped by the parent whenever it switches grid layouts. That reflows
    // this pane's cell size instantly (it's a synchronous DOM/CSS change),
    // but this component only otherwise finds out via its own ResizeObserver
    // on the cell — which fires a frame or more later. For an ordinary resize
    // that lag is invisible, but a big jump (e.g. a 2x2 tile going to single
    // view) meant the canvas visibly sat at its old, small scale for that
    // extra frame before snapping to fill the new cell — reading as the pane
    // "slowly" growing after the (fast, GPU-only) FLIP transform already
    // finished. Watching this prop lets `box` be remeasured synchronously in
    // the very same commit as the layout switch, so the canvas is already
    // correctly scaled by the first painted frame.
    layoutVersion?: number;
    // False for the single-view layout: cards there render at their natural
    // full-width 16:9 size and the page scrolls to reach the rest, rather
    // than being shrunk to fit the available height on screen.
    fitViewport?: boolean;
    // Single-clicking the header toggles this pane filling the whole main
    // content area in-page (not the OS/browser Fullscreen API — that's
    // still the double-click/Maximize-icon behavior via onDoubleClick).
    // Parent owns the "which pane is maximized" state since it affects the
    // whole grid's layout, not just this pane.
    onToggleMaximize?: () => void;
    protocol?: 'rdp' | 'vnc';
    os?: '' | 'windows' | 'macos' | 'linux';
    // Swaps Ctrl and Cmd/Meta keysyms sent to the remote — for macOS targets
    // where the user wants the physical key they'd hit for a shortcut on a PC
    // (Ctrl) to land as Cmd on the Mac, and vice versa.
    swapCtrlCmd?: boolean;
    // Whether hovering this pane focuses it (default true). Off requires an
    // explicit click, so moving the mouse across a multi-session grid doesn't
    // steal keyboard focus from whichever session the user is actually typing into.
    focusOnHover?: boolean;
    onDisconnect: () => void;
    // Issues a fresh token for this same session (see refreshInstance in
    // App.tsx). Optional so callers that don't support it can omit the button.
    onRefresh?: () => void;
    // Reported when the session fails rather than being closed deliberately —
    // guacd down, the tunnel dropping, an RDP-level refusal. The pane goes away
    // either way, so without this the failure would be invisible.
    onError?: (message: string) => void;
    // Reorder support: the grip in the header is the drag handle. The parent
    // grid cell is the drop target (see App.tsx), so these just report when a
    // drag of this pane starts/ends.
    onReorderDragStart?: (e: React.DragEvent) => void;
    onReorderDragEnd?: () => void;
    // Shared, app-wide clipboard. `clipboard` is the latest text from any source
    // (this device or another session); `onClipboard` reports text this session
    // received (a remote copy) or typed into the clipboard box, so it propagates
    // to every other open session.
    clipboard: string;
    onClipboard: (text: string) => void;
}

export const GuacamoleClient: React.FC<Props> = ({ token, name, ip, layoutVersion, fitViewport = true, onToggleMaximize, protocol, os, swapCtrlCmd, focusOnHover = true, onDisconnect, onRefresh, onError, clipboard, onClipboard, onReorderDragStart, onReorderDragEnd }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const displayRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<string>('Connecting...');
    const clientRef = useRef<Guacamole.Client | null>(null);
    // Last clipboard value this session has already sent to / received from its
    // remote, used to avoid echo loops and redundant re-pushes.
    const lastClipboard = useRef<string>('');
    // Held in a ref because the connect effect below only re-runs on `token`,
    // so it must not close over a stale callback.
    const onClipboardRef = useRef(onClipboard);
    onClipboardRef.current = onClipboard;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    // Same reason: read fresh on every keypress rather than frozen at whatever
    // it was when the pane first connected. Without this, a session that
    // mounted before its instance's `os`/`swapKeys` had loaded (e.g. a
    // session restored on page load, racing the customInstances fetch) would
    // silently and permanently ignore the setting for its whole lifetime —
    // toggling it in Settings would appear to do nothing without a reconnect.
    const swapCtrlCmdRef = useRef(swapCtrlCmd);
    swapCtrlCmdRef.current = swapCtrlCmd;
    // Read fresh inside measureBox (captured once by the mount-only
    // ResizeObserver effect below) rather than closing over the prop
    // directly, so an organic resize (e.g. the window resizing) after a
    // layout switch still uses the current fitViewport instead of whatever
    // it was when that effect first ran.
    const fitViewportRef = useRef(fitViewport);
    fitViewportRef.current = fitViewport;
    // Whether this session ever reached 'Connected', and whether it failed. A
    // disconnect that follows neither a failure nor a live session is the tunnel
    // dying on the way up — worth reporting, unlike a normal close.
    const wasConnected = useRef(false);
    const failed = useRef(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    // Explicit display size: the largest 16:9 rectangle that fits the grid cell
    // *below* the static header. Computed in JS because pure-CSS aspect-ratio
    // can't reliably produce a "largest fitting box" for a plain <div> when
    // height is the limiting axis.
    const [box, setBox] = useState<{ w: number; h: number } | null>(null);
    // Set inside the connect effect below so the box-driven layout effect
    // (which fires on every `box` change, not just reconnects) can rescale
    // the canvas without waiting on that effect's own ResizeObserver, which
    // — chained after the `box` state update that resizes displayRef — was
    // arriving a frame or more late and showing bg-black through the
    // not-yet-rescaled canvas in the meantime (most visible during rapid
    // resizes, e.g. dragging the fill-grid zoom slider).
    const scaleDisplayRef = useRef<() => void>(() => {});
    // Takes an explicit size instead of measuring displayRef itself. `box` is
    // already the exact size about to be applied to displayRef, so the
    // box-driven layout effect below can pass it straight through — reading
    // displayRef.clientWidth/Height back out right after every pane's box
    // state write is a forced-synchronous-layout trap: with several panes
    // resizing in the same commit (any grid-layout switch touches all of
    // them), each pane's read-after-write forces the browser to flush layout
    // for the others' pending writes too, and that thrashing is what showed
    // up as the sessions visibly lagging behind the (GPU-only) FLIP
    // transform during a layout switch instead of resizing with it.
    const scaleDisplayToRef = useRef<(w: number, h: number) => void>(() => {});

    // Keep the display shaped exactly 16:9 and as large as its cell allows,
    // reserving room for the static header.
    const measureBox = () => {
        const cell = rootRef.current?.parentElement;
        if (!cell) return;
        const cw = cell.clientWidth;
        if (cw <= 0) return;
        let w = cw;
        let h = (w * 9) / 16;
        // Only shrink to fit the cell's available height when this layout
        // wants everything visible without scrolling (2x2, fill, fullscreen).
        // Single view instead wants the card at its natural full-width size
        // and lets the page scroll — clamping to `ch` there is also how the
        // old min-h-screen/auto-rows-fr combo produced its runaway-growth
        // feedback loop: `ch` was itself derived from this same box.
        if (fitViewportRef.current) {
            const headerH = headerRef.current?.offsetHeight ?? 0;
            const ch = cell.clientHeight - headerH;
            if (ch <= 0) return;
            if (h > ch) { h = ch; w = (h * 16) / 9; }
        }
        setBox({ w: Math.floor(w), h: Math.floor(h) });
    };

    // When the cell (or the screen, in fullscreen) resizes, recompute so the
    // remote 1920x1080 desktop fills the display area edge-to-edge with no
    // black bars.
    useEffect(() => {
        const cell = rootRef.current?.parentElement;
        if (!cell) return;
        const ro = new ResizeObserver(measureBox);
        ro.observe(cell);
        measureBox();
        return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Also remeasure synchronously whenever the parent bumps `layoutVersion`
    // (grid layout switches) rather than waiting on the ResizeObserver above.
    // The cell's own size already changed by the time this runs (React
    // committed the new grid classes before layout effects fire), so this
    // closes the gap between "the cell resized" and "this pane found out" to
    // zero frames instead of the observer's usual one-frame-plus lag — the
    // lag that, for a big small-to-large jump like 2x2 -> single view, showed
    // up as the pane visibly snapping to size late, after the FLIP transform
    // animating the cell itself had already finished.
    useLayoutEffect(() => {
        measureBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutVersion]);

    // Rescale synchronously (before paint) whenever `box` changes size, so the
    // canvas is never shown at a stale scale for even one frame. This runs in
    // the same commit as the width/height style update above, ahead of the
    // connect effect's own ResizeObserver (which still exists as a fallback
    // for resizes `box` doesn't drive, e.g. entering fullscreen).
    useLayoutEffect(() => {
        if (box) scaleDisplayToRef.current(box.w, box.h);
    }, [box]);

    useEffect(() => {
        if (!displayRef.current) return;

        // Set right before this effect's own teardown (token change, e.g. a
        // refresh, or real unmount) so the state-5 handler below can tell "this
        // client is being intentionally torn down" apart from "the remote
        // closed the connection on us" and skip the redundant/incorrect
        // onDisconnect() in the former case.
        let cleanedUp = false;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Derive from the current mount path so it works both standalone ('/ws')
        // and behind a stripped prefix ('/rdm/ws' -> '/ws'). VITE_WS_URL overrides.
        const mountPath = window.location.pathname.replace(/[^/]*$/, '');
        const wsBase = import.meta.env.VITE_WS_URL || `${wsProtocol}//${window.location.host}${mountPath}ws`;
        const tunnel = new Guacamole.WebSocketTunnel(wsBase);
        const client = new Guacamole.Client(tunnel);
        clientRef.current = client;

        // Add display to DOM
        const display = client.getDisplay();
        const displayEl = display.getElement();
        displayRef.current.innerHTML = '';
        displayRef.current.appendChild(displayEl);

        // Fit the remote 1920x1080 desktop to a `w`x`h` box. The pane is shaped
        // 16:9 in the layout, so this fills it exactly with no letterboxing
        // and no distortion.
        const scaleDisplayTo = (w: number, h: number) => {
            if (display.getWidth() === 0 || w <= 0 || h <= 0) return;
            const scale = Math.min(w / display.getWidth(), h / display.getHeight());
            if (scale > 0) display.scale(scale);
        };
        scaleDisplayToRef.current = scaleDisplayTo;
        // Fallback for resizes not driven by `box` (e.g. the container
        // changing without the box-measuring effect having fired yet) —
        // measures displayRef itself, so unlike scaleDisplayTo above this one
        // does force a layout read, but it's only reached from this effect's
        // own ResizeObserver below rather than every pane's box update.
        const scaleDisplay = () => {
            const container = displayRef.current;
            if (!container) return;
            scaleDisplayTo(container.clientWidth, container.clientHeight);
        };
        scaleDisplayRef.current = scaleDisplay;

        // Error handler
        client.onerror = (error) => {
            console.error('Guacamole Error:', error);
            setStatus(`Error: ${error.message}`);
            failed.current = true;
            onErrorRef.current?.(error.message || 'the connection failed');
        };
        // The tunnel dies on its own when the WebSocket can't be served — most
        // often because guacd isn't there for the backend to hand off to — and
        // that never reaches client.onerror.
        tunnel.onerror = (error) => {
            console.error('Guacamole Tunnel Error:', error);
            setStatus(`Error: ${error.message}`);
            failed.current = true;
            onErrorRef.current?.(error.message || 'the tunnel closed');
        };

        // State change handler
        client.onstatechange = (state) => {
            switch (state) {
                case 0: setStatus('Idle'); break;
                case 1: setStatus('Connecting...'); break;
                case 2: setStatus('Waiting...'); break;
                case 3:
                    setStatus('Connected');
                    wasConnected.current = true;
                    // Ensure we're scaled once the connection is live, even if
                    // the remote size arrived before the container was measured.
                    scaleDisplay();
                    break;
                case 4:
                    setStatus('Disconnecting...');
                    break;
                case 5:
                    setStatus('Disconnected');
                    // This client is being torn down on purpose (token changed
                    // or the pane unmounted) rather than dropped by the remote
                    // — the disconnect is already accounted for, so don't tell
                    // the parent again.
                    if (cleanedUp) break;
                    // Dropped before it ever came up, with no error to explain
                    // it: the tunnel closed on us.
                    if (!wasConnected.current && !failed.current) {
                        failed.current = true;
                        onErrorRef.current?.('the session closed before it opened');
                    }
                    onDisconnect();
                    break;
            }
        };

        // Re-scale whenever the remote reports a new desktop size. Without this
        // the canvas stays at its native resolution until the browser window is
        // resized, which showed up as a black pane on connect.
        display.onresize = scaleDisplay;

        // Keyboard: forward keys to the remote only while THIS pane is focused
        // (i.e. the user has clicked into the session). Attached to document but
        // gated on focus so keystrokes never leak to an unfocused session or to
        // on-page inputs like the clipboard box.
        const focusTarget = displayRef.current;
        const keyboard = new Guacamole.Keyboard(document);
        const pressedKeys = new Set<number>();

        // Ctrl <-> Cmd keysyms, swapped in both directions so muscle-memory
        // shortcuts land correctly on a macOS target regardless of which one
        // was physically pressed. Apple's built-in VNC server (Screen
        // Sharing) does not implement standard RFB keyboard handling — it
        // does not honor the DOM/X11 "Meta"/"Super" keysyms a browser
        // reports for the Cmd/Win key at all (confirmed empirically: Meta_L
        // lands as Option, and the nominal RFB convention of Super_L for a
        // Windows/Super key landed as Control *and* Command held at once).
        // What actually works against Apple's server, also empirically
        // confirmed and matching a community-verified workaround for the
        // same non-compliance (see TigerVNC issue #18), is swapping the
        // Control and Alt keysyms directly: sending Alt_L lands as Cmd, and
        // sending Control_L lands as Ctrl. So this remaps the *physical*
        // Ctrl/Alt keys into each other's keysyms rather than touching
        // Meta/Super at all.
        const CTRL_L = 0xFFE3, CTRL_R = 0xFFE4;
        const ALT_L = 0xFFE9, ALT_R = 0xFFEA;
        const remapKeysym = (keysym: number) => {
            if (!swapCtrlCmdRef.current) return keysym;
            switch (keysym) {
                case CTRL_L: return ALT_L;
                case CTRL_R: return ALT_R;
                case ALT_L: return CTRL_L;
                case ALT_R: return CTRL_R;
                default: return keysym;
            }
        };

        const releaseAllKeys = () => {
            pressedKeys.forEach((keysym) => client.sendKeyEvent(0, keysym));
            pressedKeys.clear();
        };

        keyboard.onkeydown = (keysym) => {
            // Not focused: let the browser handle the key (typing in inputs, etc.)
            // and do NOT preventDefault.
            if (document.activeElement !== focusTarget) return true;
            const sent = remapKeysym(keysym);
            client.sendKeyEvent(1, sent);
            pressedKeys.add(sent);
            // Focused: preventDefault so modifier combos (Ctrl, Alt, Ctrl+Alt+…)
            // reach the remote instead of triggering the browser's own shortcuts.
            return false;
        };
        keyboard.onkeyup = (keysym) => {
            const sent = remapKeysym(keysym);
            if (!pressedKeys.has(sent)) return true;
            client.sendKeyEvent(0, sent);
            pressedKeys.delete(sent);
            return false;
        };

        // Release everything when focus leaves the pane or the window (e.g.
        // Alt+Tab). Otherwise a held Ctrl/Alt's keyup is never delivered and the
        // modifier stays stuck "down" in the session, which breaks every
        // subsequent Ctrl/Alt shortcut until you press and release it again.
        const handleFocusLoss = () => releaseAllKeys();
        focusTarget.addEventListener('blur', handleFocusLoss);
        window.addEventListener('blur', handleFocusLoss);

        // Mouse setup
        const mouse = new Guacamole.Mouse(displayEl);
        // guacamole-common-js turns each wheel event into up/down button
        // clicks once accumulated scroll distance crosses this many pixels
        // (default 53) — the RealVNC viewer exposes the identical concept as
        // "ScrollWheelThreshold" under its Expert settings. 1 was tried here
        // previously to make VNC scrolling feel less sluggish, but it's way
        // too aggressive: a single wheel tick's full deltaY collapses into
        // dozens of clicks, each read as its own scroll notch, so one tick
        // can blow past hundreds of lines. macOS VNC targets scroll a
        // shorter distance per notch than Windows/Linux ones do, so they
        // need a lower threshold to feel the same; tuned by feel per-OS.
        // VNC-only; RDP is untouched.
        // @ts-ignore — missing from the (outdated) type defs, but present at runtime
        if (protocol === 'vnc') mouse.scrollThreshold = os === 'macos' ? 6 : 30;
        // @ts-ignore
        mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState: any) => {
            const scale = display.getScale() || 1;
            const scaledState = new Guacamole.Mouse.State(
                mouseState.x / scale,
                mouseState.y / scale,
                mouseState.left,
                mouseState.middle,
                mouseState.right,
                mouseState.up,
                mouseState.down
            );
            client.sendMouseState(scaledState);
        };

        // Remote copy -> shared clipboard. Publishing to the shared clipboard is
        // what makes copy/paste work *between* sessions: every other open session
        // then receives this text (see the broadcast effect below). We also make a
        // best-effort write to the OS clipboard so it can be pasted into local apps.
        // Registered *before* connect() so a clipboard instruction that arrives
        // early in the handshake isn't dropped.
        client.onclipboard = (stream, mimetype) => {
            if (mimetype === 'text/plain') {
                const reader = new Guacamole.StringReader(stream);
                let data = '';
                reader.ontext = (text) => { data += text; };
                reader.onend = () => {
                    lastClipboard.current = data; // we already have it; don't push back
                    onClipboardRef.current(data);
                    void writeDeviceClipboard(data);
                };
            }
        };

        // This is a fresh remote with an unknown clipboard, so forget what the
        // previous connection had been told. Otherwise a reconnect (new token)
        // would see its own stale `lastClipboard` and skip re-sending the shared
        // text, leaving the reconnected session unable to paste.
        lastClipboard.current = '';

        // Connect using the token
        client.connect(`token=${token}`);

        // Scale display to fit container visually when the pane itself resizes.
        const resizeObserver = new ResizeObserver(() => scaleDisplay());
        resizeObserver.observe(displayRef.current);

        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);

        return () => {
            cleanedUp = true;
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
            focusTarget.removeEventListener('blur', handleFocusLoss);
            window.removeEventListener('blur', handleFocusLoss);
            if (resizeObserver) resizeObserver.disconnect();
            display.onresize = null;
            scaleDisplayRef.current = () => {};
            scaleDisplayToRef.current = () => {};
            keyboard.onkeydown = null;
            keyboard.onkeyup = null;
            releaseAllKeys();
            client.disconnect();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    // Push text to the remote clipboard. StringWriter/ArrayBufferWriter already
    // split the payload into protocol-sized blobs, so we send it all at once and
    // close the stream. (An earlier ack-gated version stalled after the first
    // chunk because guacd does not ack every clipboard blob, which truncated
    // long text — do not reintroduce that.) The real length ceiling is guacd's
    // GUAC_COMMON_CLIPBOARD_MAX_LENGTH, raised to 2 MiB in the custom image.
    const sendClipboard = (text: string) => {
        const client = clientRef.current;
        if (!client || text === lastClipboard.current) return;
        lastClipboard.current = text;

        const stream = client.createClipboardStream('text/plain');
        const writer = new Guacamole.StringWriter(stream);
        writer.sendText(text);
        writer.sendEnd();
    };

    // Broadcast: whenever the shared clipboard changes (from this device or any
    // other session), push it into this session's remote desktop, so pasting
    // inside the remote just works. Skips if this session already has the value.
    useEffect(() => {
        if (status === 'Connected' && clipboard && clipboard !== lastClipboard.current) {
            sendClipboard(clipboard);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clipboard, status]);

    const toggleFullscreen = () => {
        // Fullscreen the grid cell (the pane's parent) rather than the pane
        // itself, so the 16:9 sizing logic re-measures against the full screen.
        const container = rootRef.current?.parentElement;
        if (!container) return;
        if (!document.fullscreenElement) {
            container.requestFullscreen().catch(err => {
                console.error('Error attempting to enable fullscreen:', err);
            });
        } else {
            document.exitFullscreen();
        }
    };

    // Single-click toggles in-page maximize; double-click still means real
    // fullscreen. Both fire on a dblclick's first click, so the single-click
    // action is held for a beat — long enough for a second click to cancel
    // it — rather than firing immediately and then getting stepped on.
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
            className="relative bg-slate-900 border-2 border-slate-700 rounded-lg overflow-hidden flex flex-col group focus-within:border-yellow-400 focus-within:shadow-[0_0_15px_rgba(250,204,21,0.6)] transition-[border-color,box-shadow] duration-150 max-w-full max-h-full [contain:content]"
            style={box ? { width: box.w } : { width: '100%', height: '100%' }}
            onClick={() => displayRef.current?.focus({ preventScroll: true })}
            onMouseEnter={focusOnHover ? () => displayRef.current?.focus({ preventScroll: true }) : undefined}
        >
            {/* Static header above the session. Controls only reveal on hover
                of the bar itself (not the whole card) so a live desktop isn't
                permanently overlaid with buttons. */}
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
                <div className="flex gap-4 items-center shrink-0 ml-4 opacity-0 group-hover/bar:opacity-100 transition-opacity">
                    {onRefresh && (
                        <button onClick={(e) => { e.stopPropagation(); onRefresh(); }} className="text-slate-300 hover:text-white transition-colors" title="Refresh session">
                            <RefreshCw size={16} />
                        </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} className="text-slate-300 hover:text-white transition-colors" title="Fullscreen">
                        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onDisconnect(); }} className="text-red-400 hover:text-red-300 transition-colors" title="Disconnect">
                        <X size={20} />
                    </button>
                </div>
            </div>

            {/* Display area — JS-sized to a 16:9 box so the 1920x1080 desktop
                fills it with no letterboxing */}
            <div
                ref={displayRef}
                className="relative flex items-center justify-center outline-none cursor-none overflow-hidden bg-black shrink-0"
                style={box ? { width: box.w, height: box.h } : { flex: 1, width: '100%' }}
                tabIndex={0}
            />
        </div>
    );
}
