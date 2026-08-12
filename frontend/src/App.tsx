import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { Grid, LayoutGrid, Maximize, Square, PlayCircle, StopCircle, RefreshCw, PanelLeftClose, PanelLeftOpen, Plus, X, ChevronUp, ChevronDown, Settings, GalleryHorizontalEnd, Loader2, DollarSign, AlertTriangle, ArrowUpDown, GripVertical, Check, Cpu, LogOut, ShieldCheck, ShieldOff } from 'lucide-react';
import { GuacamoleClient } from './GuacamoleClient';
import { FileTransferPanel } from './FileTransferPanel';
import { useDeviceClipboard } from './deviceClipboard';
import { OS_ICONS } from './OsIcons';
import type { AuthStatus } from './Auth';
import './index.css';

let toastSeq = 0;
interface Toast { id: number; message: string; type: 'error' | 'success' | 'info'; }

interface EC2Instance {
    id: string;
    name: string;
    state: string;
    // Hardware size, e.g. 'c5a.xlarge'.
    instanceType?: string;
    // A resize is constrained by both: the new type must support the same
    // architecture ('x86_64' / 'arm64') and be offered in this AZ.
    architecture?: string;
    az?: string;
    // The AMI's OS ('Windows', 'Linux/UNIX', …) — on-demand rates are per OS,
    // so this decides which price list the picker quotes.
    platformDetails?: string;
    // Why AWS put it in that state — see the backend's /api/instances.
    stateReasonCode?: string;
    stateReasonMessage?: string;
    publicIp?: string;
    privateIp?: string;
    // User-set overrides (see backend ec2_settings)
    label?: string;
    username?: string;
    hasPassword?: boolean;
    os?: '' | 'windows' | 'macos' | 'linux';
    swapKeys?: boolean;
}

// One entry of the region's instance-type catalogue (backend /api/instance-types).
interface InstanceTypeSpec {
    name: string;
    vcpus?: number;
    memoryMib?: number;
    network?: string;
    // Numeric form of `network` — AWS states it as prose, which won't sort.
    networkGbps: number;
    clockSpeedGhz?: number;
    architectures: string[];
    currentGeneration: boolean;
    burstable: boolean;
    storage: string;
    gpu?: string;
    // On-demand USD/hour, absent when pricing couldn't be read.
    hourly?: number;
}

// Whether the cost columns could be filled in, and what they're quoting.
interface PricingMeta {
    available: boolean;
    os?: string;
    region?: string;
    error?: string;
}

interface InstanceTypeResponse {
    types: InstanceTypeSpec[];
    pricing: PricingMeta;
}

// Everything an instance needs to identify its catalogue. Instances agreeing on
// all three share one — which is what makes the cache worth having.
const catalogueKeyFor = (inst: EC2Instance) =>
    `${inst.architecture || ''}|${inst.az || ''}|${inst.platformDetails || ''}`;

// Columns the type table can be ordered by. 'name' orders by family then size
// (the natural reading of an instance type), not raw alphabetical.
type TypeSortKey = 'name' | 'vcpus' | 'memoryMib' | 'networkGbps' | 'hourly';
interface TypeSort { key: TypeSortKey; dir: 'asc' | 'desc' }

const familyOf = (name: string) => name.split('.')[0] || name;

// 'c5a.2xlarge' after 'c5a.xlarge' — plain alphabetical would put every
// multi-digit size first ('12xlarge' before '2xlarge').
const compareNatural = (a: InstanceTypeSpec, b: InstanceTypeSpec) => {
    const fa = familyOf(a.name);
    const fb = familyOf(b.name);
    if (fa !== fb) return fa.localeCompare(fb);
    if ((a.vcpus ?? 0) !== (b.vcpus ?? 0)) return (a.vcpus ?? 0) - (b.vcpus ?? 0);
    if ((a.memoryMib ?? 0) !== (b.memoryMib ?? 0)) return (a.memoryMib ?? 0) - (b.memoryMib ?? 0);
    return a.name.localeCompare(b.name);
};

const sortSpecs = (specs: InstanceTypeSpec[], { key, dir }: TypeSort) => {
    const factor = dir === 'asc' ? 1 : -1;
    return [...specs].sort((a, b) => {
        if (key === 'name') return compareNatural(a, b) * factor;
        const av = a[key];
        const bv = b[key];
        // A type with no figure (an unpriced one, say) is noise either way up,
        // so it sits at the bottom in both directions.
        if (av === undefined && bv === undefined) return compareNatural(a, b);
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        if (av !== bv) return (av - bv) * factor;
        return compareNatural(a, b);
    });
};

const formatUsd = (amount: number | undefined, digits: number) =>
    amount === undefined
        ? '—'
        : `$${amount.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

// Sort indicator in a column header — the direction when that column is the
// active one, a dimmed hint that the column *can* be sorted otherwise.
const SortArrow = ({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) =>
    active
        ? (dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
        : <ArrowUpDown size={11} className="opacity-30" />;

// Small flat glyph shown next to an instance once its OS is set (see OsIcons.tsx).
const OsIcon = ({ os, size = 13, className = '' }: { os?: string; size?: number; className?: string }) => {
    if (!os || !OS_ICONS[os]) return null;
    const Icon = OS_ICONS[os];
    const label = os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux';
    return <Icon size={size} className={className} aria-label={label} />;
};

interface ActiveSession {
    instanceId: string;
    token: string;
    name: string;
    ip: string;
}

interface CustomInstance {
    id: string;
    name: string;
    ip: string;
    username: string;
    protocol?: 'rdp' | 'vnc';
    hasPassword?: boolean;
    os?: '' | 'windows' | 'macos' | 'linux';
    swapKeys?: boolean;
}

interface Billing {
    available: boolean;
    amount?: number;
    currency?: string;
}

// guacd — the daemon that actually speaks RDP. `controllable` is false when the
// backend has no service configured to act on (GUACD_SERVICE unset).
interface GuacdStatus {
    reachable: boolean;
    host: string;
    port: number;
    controllable: boolean;
    service: string;
    error?: string;
}

type GuacdAction = 'start' | 'stop' | 'restart';

// Which instance the settings modal is editing, and in what mode.
type InstanceModal =
    | { mode: 'add' }
    | { mode: 'edit-custom'; id: string }
    | { mode: 'edit-ec2'; id: string };

interface ConfirmState {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
}

// Mount point the app is served from — '/' standalone, or '/rdm/' (etc.)
// behind a path-stripping reverse proxy. Derived from the page URL so no build
// step is tied to a specific prefix. `VITE_API_URL` still overrides if set.
const MOUNT_PATH = window.location.pathname.replace(/[^/]*$/, '');
const API_BASE = import.meta.env.VITE_API_URL || `${MOUNT_PATH}api`;

// How often to re-poll AWS while an instance is mid-transition, and how long a
// start/stop may drag on before we give up on it and say so (a boot or shutdown
// normally reports back well inside this).
const TRANSITION_POLL_MS = 3000;
const TRANSITION_TIMEOUT_MS = 5 * 60 * 1000;

// EC2's API is eventually consistent: a DescribeInstances issued straight after
// a resize routinely still reports the old instance type. Long enough to outlast
// that, short enough to give up rather than poll forever.
const TYPE_CONSISTENCY_POLL_MS = 1500;
const TYPE_CONSISTENCY_TIMEOUT_MS = 20000;

// guacd going down drops every open session at once; they'd otherwise each
// raise the same notice.
const GUACD_TOAST_DEDUPE_MS = 10000;

// A session always dies partway through its machine's shutdown, and guacd
// describes that in alarming terms ("Connection failed (server unreachable?)")
// even though it's exactly what was asked for. So a session error on an
// instance we're stopping is held this long: if the instance reaches 'stopped',
// it's dropped; if the shutdown is instead stuck, the held reason is reported.
const SHUTDOWN_GRACE_MS = 60000;
const STOPPED_STATES = ['stopped', 'terminated'];
const SHUTTING_DOWN_STATES = ['stopping', 'shutting-down'];

// API errors come back as `{ error }`; fall back to the raw body for anything
// that isn't JSON (a proxy error page, say).
const readErrorMessage = async (res: Response) => {
    const body = (await res.text()).trim();
    try {
        return JSON.parse(body).error || body;
    } catch {
        return body || `HTTP ${res.status}`;
    }
};

// AWS reports memory in MiB; GiB is how instance types are actually talked
// about. Halves show up in the smaller sizes (t3.micro is 1 GiB, t3.small 2).
const formatMemory = (mib?: number) => {
    if (mib === undefined) return '—';
    const gib = mib / 1024;
    return `${gib < 1 ? gib.toFixed(2).replace(/0+$/, '') : gib % 1 ? gib.toFixed(1) : gib} GiB`;
};

// A start/stop we've asked AWS for and are still waiting to see happen.
interface TransitionRequest {
    requestedAt: number;
    // The StateReason code the instance carried when we sent the request. AWS
    // reports a failed start (capacity, internal error) as the instance simply
    // arriving back at 'stopped' — the *new* reason code is the only signal that
    // this attempt is the thing that failed, rather than one still in flight.
    baselineReason: string;
}

type TransitionRequests = Record<string, TransitionRequest>;

const beginRequests = (instanceIds: string[], instances: EC2Instance[]): TransitionRequests => {
    const now = Date.now();
    return Object.fromEntries(instanceIds.map(id => [id, {
        requestedAt: now,
        baselineReason: instances.find(i => i.id === id)?.stateReasonCode || ''
    }]));
};

const dropRequests = (requests: TransitionRequests, instanceIds: string[]) => {
    if (!instanceIds.some(id => requests[id])) return requests;
    const next = { ...requests };
    instanceIds.forEach(id => delete next[id]);
    return next;
};

// Settles outstanding requests against what AWS now reports. A request lives
// until the instance reaches `target` (done), comes to rest back at `source`
// with a new reason (failed), or runs out of time — while it lives, the button
// stays a spinner rather than flipping back to Start/Stop mid-transition.
// Returns `requests` itself when nothing changed, to avoid pointless re-renders.
const reconcileRequests = (
    requests: TransitionRequests,
    byId: Map<string, EC2Instance>,
    source: string,
    target: string
) => {
    const now = Date.now();
    const next: TransitionRequests = {};
    const failures: { id: string; message: string }[] = [];

    for (const [id, req] of Object.entries(requests)) {
        const inst = byId.get(id);
        // Gone (terminated) or arrived: nothing left to wait on.
        if (!inst || inst.state === target) continue;

        if (inst.state === source && inst.stateReasonCode !== req.baselineReason) {
            failures.push({ id, message: inst.stateReasonMessage || inst.stateReasonCode || 'AWS gave no reason' });
            continue;
        }
        if (now - req.requestedAt > TRANSITION_TIMEOUT_MS) {
            failures.push({
                id,
                message: inst.state === source
                    ? "AWS hasn't acted on the request"
                    : `still '${inst.state}' after ${Math.round(TRANSITION_TIMEOUT_MS / 60000)} minutes`
            });
            continue;
        }
        next[id] = req;
    }

    const unchanged = !failures.length && Object.keys(next).length === Object.keys(requests).length;
    return { next: unchanged ? requests : next, failures };
};

interface AppProps {
    authStatus: AuthStatus;
    onAuthRefresh: () => void;
}

function App({ authStatus, onAuthRefresh }: AppProps) {
    const [instances, setInstances] = useState<EC2Instance[]>([]);
    const [activeSessions, setActiveSessions] = useState<Record<string, ActiveSession>>({});
    // Explicit render order for the grid, so panes can be dragged to reorder.
    // Persisted to localStorage so an arrangement survives reloads/reconnects.
    const [sessionOrder, setSessionOrder] = useState<string[]>(() => {
        try { return JSON.parse(localStorage.getItem('rdpm_order') || '[]'); } catch { return []; }
    });
    // Dedicated full-view reorder mode: minimizes every session into compact,
    // easily-draggable tiles so ordering works regardless of the grid layout.
    const [reorderMode, setReorderMode] = useState(false);
    // Transient notifications (connection failures, etc.).
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [gridLayout, setGridLayout] = useState<number>(2); // 1 = 1x1, 2 = 2x2, 4 = 4x4
    // FLIP-animate grid-layout switches: CSS can't reliably interpolate a
    // reflow that changes grid-template-columns/rows (or swaps grid<->flex
    // for horizontal scroll) — depending on direction and magnitude, browsers
    // either skip the transition, snap partway through, or (for a big jump
    // like going to single view) visibly lag the JS-computed 16:9 box behind
    // the CSS-animated cell size. Measuring each cell's rect before/after and
    // tweening a `transform` between them sidesteps all of that: transform is
    // always interpolable, regardless of what layout changed underneath.
    const gridCellRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const pendingFlipRects = useRef<Record<string, DOMRect> | null>(null);
    const changeGridLayout = (next: number) => {
        const rects: Record<string, DOMRect> = {};
        for (const [id, el] of Object.entries(gridCellRefs.current)) {
            if (el) rects[id] = el.getBoundingClientRect();
        }
        pendingFlipRects.current = rects;
        setGridLayout(next);
    };
    useLayoutEffect(() => {
        const before = pendingFlipRects.current;
        pendingFlipRects.current = null;
        if (!before) return;
        for (const [id, el] of Object.entries(gridCellRefs.current)) {
            const from = before[id];
            if (!el || !from) continue; // newly-appeared cell — nothing to animate from
            const to = el.getBoundingClientRect();
            const dx = from.left - to.left;
            const dy = from.top - to.top;
            const sx = from.width / to.width;
            const sy = from.height / to.height;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
            el.style.transition = 'none';
            el.style.transformOrigin = 'top left';
            el.style.willChange = 'transform';
            el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
            el.getBoundingClientRect(); // force the browser to register the "from" state
            requestAnimationFrame(() => {
                el.style.transition = 'transform 200ms ease-out';
                el.style.transform = '';
            });
            el.addEventListener('transitionend', () => {
                el.style.transition = '';
                el.style.transformOrigin = '';
                el.style.willChange = '';
            }, { once: true });
        }
    }, [gridLayout]);
    const [isSidebarVisible, setIsSidebarVisible] = useState<boolean>(() => {
        const stored = localStorage.getItem('rdpm_sidebar');
        return stored !== null ? stored === 'true' : true;
    });
    const [isHeaderVisible, setIsHeaderVisible] = useState<boolean>(() => {
        const stored = localStorage.getItem('rdpm_header');
        return stored !== null ? stored === 'true' : true;
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [customInstances, setCustomInstances] = useState<CustomInstance[]>([]);
    const [billing, setBilling] = useState<Billing | null>(null);
    // Shared clipboard across all open sessions (and this device), enabling
    // copy/paste between sessions, not just device -> session. Every pane pushes
    // this text into its remote desktop, and reports back anything copied inside
    // it (see GuacamoleClient), so a copy anywhere is pastable everywhere.
    const [sharedClipboard, setSharedClipboard] = useState('');

    // File transfer panel — null when closed, otherwise holds the instance ID
    // of the session whose header button was clicked (pre-selected as source).
    const [fileTransferPanel, setFileTransferPanel] = useState<{ fromInstanceId: string } | null>(null);

    // Per-instance loading states
    const [connecting, setConnecting] = useState<Record<string, boolean>>({});
    const [starting, setStarting] = useState<TransitionRequests>({});
    const [stopping, setStopping] = useState<TransitionRequests>({});
    // Mirrors of the two above, so the transition poller (whose interval closure
    // is fixed at the render that started it) always reconciles against the
    // current requests, and so overlapping fetches can't report a failure twice.
    const startingRef = useRef(starting);
    const stoppingRef = useRef(stopping);
    useEffect(() => { startingRef.current = starting; }, [starting]);
    useEffect(() => { stoppingRef.current = stopping; }, [stopping]);
    // Same reason, for the deferred session-error timers: they fire a minute
    // after the fact and need the instance list as it is then, not as it was.
    const instancesRef = useRef(instances);
    useEffect(() => { instancesRef.current = instances; }, [instances]);

    const [hasRestored, setHasRestored] = useState(false);

    // Instance add/edit modal + its form.
    const [instanceModal, setInstanceModal] = useState<InstanceModal | null>(null);
    const [instanceForm, setInstanceForm] = useState({
        name: '', ip: '', username: 'Administrator', protocol: 'rdp' as 'rdp' | 'vnc',
        os: '' as '' | 'windows' | 'macos' | 'linux', swapKeys: false,
        password: '', changePassword: false, hasPassword: false
    });

    // Reusable confirmation dialog (used for every stop action).
    const [confirm, setConfirm] = useState<ConfirmState | null>(null);

    // Instance-type picker, opened from the EC2 settings modal. The catalogue is
    // ~hundreds of entries per architecture and never changes, so it's fetched
    // once per architecture and kept for the session.
    const [typeModal, setTypeModal] = useState<{ instanceId: string } | null>(null);
    const [instanceTypes, setInstanceTypes] = useState<InstanceTypeSpec[] | null>(null);
    const [pricingMeta, setPricingMeta] = useState<PricingMeta | null>(null);
    const [typesError, setTypesError] = useState('');
    const [typeSearch, setTypeSearch] = useState('');
    const [typeSelection, setTypeSelection] = useState('');
    const [currentGenOnly, setCurrentGenOnly] = useState(true);
    // Exact-match spec filters; '' means "any". Their options come from the
    // catalogue itself, so they only ever offer values that exist.
    const [typeFilters, setTypeFilters] = useState({ vcpus: '', memoryMib: '', network: '' });
    const [changingType, setChangingType] = useState(false);
    const [typeSort, setTypeSort] = useState<TypeSort>({ key: 'name', dir: 'asc' });
    // Catalogues are keyed by architecture + AZ + platform — every instance
    // sharing those three sees the same list, so one fetch serves all of them.
    // Resolved values are kept for an instant open; the in-flight promises are
    // kept alongside so a prefetch and an open can't duplicate the same request.
    const typeCache = useRef<Record<string, InstanceTypeResponse>>({});
    const typeRequests = useRef<Record<string, Promise<InstanceTypeResponse>>>({});
    // The catalogue the open modal is waiting on, so a slow fetch can't land on
    // a modal that's since been reopened for a different instance.
    const typeRequest = useRef('');

    // Drag-to-reorder state for the grid.
    const [dragId, setDragId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    // A transparent 1x1 image used as the native drag ghost, so dragging shows
    // our own styled source/placeholder instead of a bitmap of the video pane.
    const dragImgRef = useRef<HTMLImageElement | null>(null);
    useEffect(() => {
        const img = new Image();
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        dragImgRef.current = img;
    }, []);
    const setBlankDragImage = (e: React.DragEvent) => {
        if (dragImgRef.current) e.dataTransfer.setDragImage(dragImgRef.current, 0, 0);
        e.dataTransfer.effectAllowed = 'move';
    };

    const pushToast = useCallback((message: string, type: Toast['type'] = 'error') => {
        const id = ++toastSeq;
        setToasts(prev => [...prev, { id, message, type }]);
        // Errors linger a little longer so the reason is readable.
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 4000);
    }, []);
    const dismissToast = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

    // Single entry point for "this text is the clipboard now". Deduping against
    // the current value is what keeps sessions from echoing each other: a pane
    // pushes text into its remote, the remote announces that same text back, and
    // the republish lands here as a no-op instead of bouncing around the grid.
    const publishClipboard = useCallback((text: string) => {
        setSharedClipboard(prev => (prev === text ? prev : text));
    }, []);

    // Device (OS) clipboard -> shared clipboard. Polled while this tab has focus
    // and re-read the moment it regains focus, so text copied in another app is
    // already in every session by the time you go to paste it.
    useDeviceClipboard(publishClipboard);

    // Settings Modal State
    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [globalSettings, setGlobalSettings] = useState({ fontSmoothing: true, colorDepth: '32', vncLossless: false });

    // guacd status + service control, shown in the settings modal.
    const [guacd, setGuacd] = useState<GuacdStatus | null>(null);
    const [guacdAction, setGuacdAction] = useState<GuacdAction | null>(null);

    const fetchGuacd = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/guacd`);
            if (res.ok) setGuacd(await res.json());
        } catch (e) {
            console.error('Failed to fetch guacd status', e);
        }
    }, []);

    // Only checked while the modal is open — it's a live TCP probe on the
    // backend, not worth running against a closed dialog.
    useEffect(() => {
        if (isSettingsModalOpen) fetchGuacd();
    }, [isSettingsModalOpen, fetchGuacd]);

    // Security section (Settings modal) — password change, optional TOTP 2FA,
    // and the inactivity auto-logout threshold. The session itself is owned
    // by AuthGate (see Auth.tsx); this just triggers changes and asks it to
    // re-fetch `/api/auth/status` afterwards via onAuthRefresh.
    const [pwCurrent, setPwCurrent] = useState('');
    const [pwNew, setPwNew] = useState('');
    const [pwConfirm, setPwConfirm] = useState('');
    const [pwBusy, setPwBusy] = useState(false);

    const [totpSetup, setTotpSetup] = useState<{ qr: string; secret: string } | null>(null);
    const [totpCode, setTotpCode] = useState('');
    const [totpBusy, setTotpBusy] = useState(false);
    const [showTotpDisable, setShowTotpDisable] = useState(false);
    const [totpDisablePassword, setTotpDisablePassword] = useState('');

    const [inactivityMinutes, setInactivityMinutes] = useState(String(authStatus.inactivityTimeoutMinutes ?? 0));
    const [inactivityBusy, setInactivityBusy] = useState(false);
    useEffect(() => {
        setInactivityMinutes(String(authStatus.inactivityTimeoutMinutes ?? 0));
    }, [authStatus.inactivityTimeoutMinutes]);

    const changePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (pwNew !== pwConfirm) return pushToast("New passwords don't match", 'error');
        setPwBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            pushToast('Password changed', 'success');
            setPwCurrent(''); setPwNew(''); setPwConfirm('');
        } catch (err: any) {
            pushToast(err.message || 'Failed to change password', 'error');
        } finally {
            setPwBusy(false);
        }
    };

    const startTotpSetup = async () => {
        setTotpBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/totp/setup`, { method: 'POST' });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            const data = await res.json();
            setTotpSetup({ qr: data.qr, secret: data.secret });
        } catch (err: any) {
            pushToast(err.message || 'Failed to start 2FA setup', 'error');
        } finally {
            setTotpBusy(false);
        }
    };

    const confirmTotpSetup = async (e: React.FormEvent) => {
        e.preventDefault();
        setTotpBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/totp/verify-setup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: totpCode })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            pushToast('Two-factor authentication enabled', 'success');
            setTotpSetup(null);
            setTotpCode('');
            onAuthRefresh();
        } catch (err: any) {
            pushToast(err.message || 'Invalid code', 'error');
        } finally {
            setTotpBusy(false);
        }
    };

    const disableTotp = async (e: React.FormEvent) => {
        e.preventDefault();
        setTotpBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/totp/disable`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: totpDisablePassword })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            pushToast('Two-factor authentication disabled', 'success');
            setShowTotpDisable(false);
            setTotpDisablePassword('');
            onAuthRefresh();
        } catch (err: any) {
            pushToast(err.message || 'Failed to disable 2FA', 'error');
        } finally {
            setTotpBusy(false);
        }
    };

    const saveInactivityTimeout = async () => {
        const minutes = Number(inactivityMinutes);
        if (!Number.isFinite(minutes) || minutes < 0) return pushToast('Enter a valid number of minutes', 'error');
        setInactivityBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/inactivity-timeout`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ minutes })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            pushToast(minutes > 0 ? `Auto-logout set to ${minutes} minute${minutes === 1 ? '' : 's'} of inactivity` : 'Inactivity auto-logout disabled', 'success');
            onAuthRefresh();
        } catch (err: any) {
            pushToast(err.message || 'Failed to save', 'error');
        } finally {
            setInactivityBusy(false);
        }
    };

    const logout = async () => {
        try {
            await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
        } finally {
            onAuthRefresh();
        }
    };

    const runGuacdAction = async (action: GuacdAction) => {
        setGuacdAction(action);
        try {
            const res = await fetch(`${API_BASE}/guacd/${action}`, { method: 'POST' });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            const status: GuacdStatus = await res.json();
            setGuacd(status);
            // The daemon settling into the expected state is the actual success
            // condition — `systemctl start` returning 0 is not.
            const expected = action !== 'stop';
            if (status.reachable === expected) {
                pushToast(`guacd ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, 'success');
            } else {
                pushToast(status.error || `guacd did not ${action} — it is still ${status.reachable ? 'running' : 'down'}.`, 'error');
            }
        } catch (err: any) {
            pushToast(err.message || `Failed to ${action} guacd`, 'error');
            fetchGuacd();
        } finally {
            setGuacdAction(null);
        }
    };

    // Stopping or restarting kills every live session, so both are confirmed.
    const requestGuacdAction = (action: GuacdAction) => {
        if (action === 'start') return runGuacdAction(action);
        const openSessions = Object.keys(activeSessions).length;
        setConfirm({
            title: action === 'stop' ? 'Stop guacd' : 'Restart guacd',
            message: openSessions
                ? `${action === 'stop' ? 'Stopping' : 'Restarting'} guacd ends ${openSessions === 1 ? 'the open session' : `all ${openSessions} open sessions`} immediately. The instances themselves keep running.`
                : `${action === 'stop' ? 'Stop' : 'Restart'} the guacd service? No sessions are open. ${action === 'stop' ? 'New connections will fail until it is started again.' : ''}`.trim(),
            confirmLabel: action === 'stop' ? 'Stop guacd' : 'Restart guacd',
            onConfirm: () => runGuacdAction(action)
        });
    };

    useEffect(() => {
        fetchInstances();
        fetchCustomInstances();
        fetchBilling();
        const storedSettings = localStorage.getItem('rdpm_settings');
        if (storedSettings) {
            try { setGlobalSettings(JSON.parse(storedSettings)); } catch(e){}
        }
    }, []);

    // Session persistence: sessionStorage tracks which sessions were open;
    // localStorage ('rdpm_order') remembers their arrangement across reloads.
    useEffect(() => {
        if (!hasRestored) {
            const stored = sessionStorage.getItem('rdpm_active_sessions');
            if (stored) {
                try {
                    const activeIds: string[] = JSON.parse(stored);
                    const remembered: string[] = (() => {
                        try { return JSON.parse(localStorage.getItem('rdpm_order') || '[]'); } catch { return []; }
                    })();
                    // Reconnect in the remembered order; append any that weren't ranked.
                    const ordered = [
                        ...remembered.filter(id => activeIds.includes(id)),
                        ...activeIds.filter(id => !remembered.includes(id))
                    ];
                    ordered.forEach((id: string) => connectInstance(id));
                } catch (e) {}
            }
            setHasRestored(true);
        } else {
            sessionStorage.setItem('rdpm_active_sessions', JSON.stringify(Object.keys(activeSessions)));
        }
    }, [activeSessions, hasRestored]);

    // Remember the arrangement.
    useEffect(() => {
        localStorage.setItem('rdpm_order', JSON.stringify(sessionOrder));
    }, [sessionOrder]);

    // UI State persistence
    useEffect(() => {
        localStorage.setItem('rdpm_sidebar', isSidebarVisible.toString());
    }, [isSidebarVisible]);

    useEffect(() => {
        localStorage.setItem('rdpm_header', isHeaderVisible.toString());
    }, [isHeaderVisible]);

    // An instance counts as transitioning while we're waiting on a start/stop we
    // sent (AWS can still report the old state for a moment) and for as long as
    // it reports 'pending'/'stopping'. Deriving it from the reported state — not
    // just from our own click — means a reload mid-boot still shows the spinner.
    const isStarting = (inst: EC2Instance) => !!starting[inst.id] || inst.state === 'pending';
    const isStopping = (inst: EC2Instance) => !!stopping[inst.id] || inst.state === 'stopping';
    const anyTransitioning = instances.some(inst => isStarting(inst) || isStopping(inst));

    // Poll while anything is mid-transition so the list lands on the new state on
    // its own, instead of needing a manual refresh.
    useEffect(() => {
        if (!anyTransitioning) return;
        const timer = setInterval(() => fetchInstances(true), TRANSITION_POLL_MS);
        return () => clearInterval(timer);
    }, [anyTransitioning]);

    const fetchBilling = async () => {
        try {
            const res = await fetch(`${API_BASE}/billing`);
            if (res.ok) setBilling(await res.json());
        } catch (e) {
            console.error('Failed to fetch billing', e);
        }
    };

    const fetchCustomInstances = async () => {
        try {
            const res = await fetch(`${API_BASE}/custom-instances`);
            if (res.ok) {
                const data = await res.json();
                setCustomInstances(data);
            }
        } catch (e) {
            console.error('Failed to fetch custom instances', e);
        }
    };

    // Settles outstanding start/stop requests against a fresh instance list, and
    // reports the ones that didn't get where they were going. The refs are
    // updated up front so a second fetch landing mid-update can't re-toast a
    // failure this one already reported.
    const settleTransitions = useCallback((data: EC2Instance[]) => {
        const byId = new Map(data.map(i => [i.id, i]));
        const nameOf = (id: string) => {
            const inst = byId.get(id);
            return inst ? (inst.label || inst.name) : id;
        };

        const started = reconcileRequests(startingRef.current, byId, 'stopped', 'running');
        if (started.next !== startingRef.current) {
            startingRef.current = started.next;
            setStarting(started.next);
        }
        const stopped = reconcileRequests(stoppingRef.current, byId, 'running', 'stopped');
        if (stopped.next !== stoppingRef.current) {
            stoppingRef.current = stopped.next;
            setStopping(stopped.next);
        }

        started.failures.forEach(f => pushToast(`Failed to start ${nameOf(f.id)}: ${f.message}`, 'error'));
        stopped.failures.forEach(f => pushToast(`Failed to stop ${nameOf(f.id)}: ${f.message}`, 'error'));
    }, [pushToast]);

    // `silent` is used by the transition poller below, which runs on a timer and
    // shouldn't spin the toolbar refresh icon or surface transient errors.
    const fetchInstances = async (silent = false) => {
        if (!silent) {
            setLoading(true);
            setError('');
        }
        try {
            const res = await fetch(`${API_BASE}/instances`);
            if (!res.ok) throw new Error(await readErrorMessage(res));
            const data: EC2Instance[] = await res.json();
            setInstances(data);
            settleTransitions(data);
        } catch (err: any) {
            if (!silent) setError(err.message);
        } finally {
            if (!silent) setLoading(false);
        }
    };

    const connectInstance = async (instanceId: string) => {
        if (activeSessions[instanceId] || connecting[instanceId]) return;
        // A fresh attempt supersedes any reason still held from the last one, so
        // reconnecting a restarted instance doesn't surface a stale notice.
        clearTimeout(shutdownGrace.current[instanceId]);
        delete shutdownGrace.current[instanceId];

        setConnecting(prev => ({ ...prev, [instanceId]: true }));
        try {
            const isCustom = instanceId.startsWith('custom-');
            const body = isCustom ? { customId: instanceId, settings: globalSettings } : { instanceId, settings: globalSettings };

            let name = instanceId;
            let ip = '';
            if (isCustom) {
                const c = customInstances.find(c => c.id === instanceId);
                if (c) { name = c.name; ip = c.ip; }
            } else {
                const c = instances.find(c => c.id === instanceId);
                if (c) { name = c.label || c.name; ip = c.publicIp || c.privateIp || ''; }
            }

            const res = await fetch(`${API_BASE}/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            const data = await res.json();

            setActiveSessions(prev => ({
                ...prev,
                [instanceId]: {
                    instanceId,
                    token: data.token,
                    name,
                    ip
                }
            }));
            setSessionOrder(prev => prev.includes(instanceId) ? prev : [...prev, instanceId]);
        } catch (err: any) {
            // Surface the actual reason (bad password, instance unreachable,
            // guacd/RDP error, etc.) rather than a generic failure.
            const reason = (err?.message || 'Unknown error').toString().trim();
            const label = instances.find(i => i.id === instanceId)?.name
                || customInstances.find(c => c.id === instanceId)?.name
                || instanceId;
            pushToast(`Couldn't connect to ${label}: ${reason}`, 'error');
        } finally {
            setConnecting(prev => ({ ...prev, [instanceId]: false }));
        }
    };

    // Re-issues a fresh token for an already-connected session and swaps it in,
    // which makes GuacamoleClient tear down and re-establish its tunnel. Reuses
    // /connect rather than a disconnect+connect cycle so it doesn't race
    // connectInstance's "already active" guard, and is cheap: the SSM tunnel
    // (if any) is already open and startSSMTunnel just hands back its port.
    const refreshInstance = async (instanceId: string) => {
        if (!activeSessions[instanceId]) return;
        try {
            const isCustom = instanceId.startsWith('custom-');
            const body = isCustom ? { customId: instanceId, settings: globalSettings } : { instanceId, settings: globalSettings };
            const res = await fetch(`${API_BASE}/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            const data = await res.json();
            setActiveSessions(prev => prev[instanceId] ? { ...prev, [instanceId]: { ...prev[instanceId], token: data.token } } : prev);
        } catch (err: any) {
            const reason = (err?.message || 'Unknown error').toString().trim();
            const label = instances.find(i => i.id === instanceId)?.name
                || customInstances.find(c => c.id === instanceId)?.name
                || instanceId;
            pushToast(`Couldn't refresh ${label}: ${reason}`, 'error');
        }
    };

    // Open the add/edit modal, prefilled for the target.
    const openAddModal = () => {
        setInstanceForm({ name: '', ip: '', username: 'Administrator', protocol: 'rdp', os: '', swapKeys: false, password: '', changePassword: true, hasPassword: false });
        setInstanceModal({ mode: 'add' });
    };

    const openEditCustom = (inst: CustomInstance) => {
        setInstanceForm({ name: inst.name, ip: inst.ip, username: inst.username || 'Administrator', protocol: inst.protocol || 'rdp', os: inst.os || '', swapKeys: !!inst.swapKeys, password: '', changePassword: false, hasPassword: !!inst.hasPassword });
        setInstanceModal({ mode: 'edit-custom', id: inst.id });
    };

    const openEditEc2 = (inst: EC2Instance) => {
        setInstanceForm({
            name: inst.label || inst.name,
            ip: inst.publicIp || inst.privateIp || '',
            username: inst.username || 'Administrator',
            protocol: 'rdp',
            os: inst.os || '', swapKeys: !!inst.swapKeys,
            password: '', changePassword: false, hasPassword: !!inst.hasPassword
        });
        setInstanceModal({ mode: 'edit-ec2', id: inst.id });
    };

    // Fetches a catalogue once and hands the same promise to every later caller,
    // so a prefetch already running is what an open waits on rather than firing
    // a second identical request.
    const loadInstanceTypes = useCallback((key: string) => {
        let pending = typeRequests.current[key];
        if (!pending) {
            const [arch = '', az = '', platform = ''] = key.split('|');
            pending = (async () => {
                const query = new URLSearchParams({ arch, az, platform });
                const res = await fetch(`${API_BASE}/instance-types?${query}`);
                if (!res.ok) throw new Error(await readErrorMessage(res));
                const data: InstanceTypeResponse = await res.json();
                typeCache.current[key] = data;
                return data;
            })();
            typeRequests.current[key] = pending;
            // A failure shouldn't be remembered as the answer — let the next
            // attempt try again.
            pending.catch(() => { delete typeRequests.current[key]; });
        }
        return pending;
    }, []);

    // Warm every catalogue the visible instances need, in the background, so the
    // picker opens instantly whichever instance it's opened from. Keyed off the
    // set of distinct catalogues rather than the instance list itself, so the
    // transition poller re-running doesn't re-trigger this.
    const catalogueKeys = instances.map(catalogueKeyFor).filter(k => k !== '||');
    const catalogueSignature = [...new Set(catalogueKeys)].sort().join(',');
    useEffect(() => {
        if (!catalogueSignature) return;
        let cancelled = false;
        (async () => {
            // Sequentially: these are several paginated AWS sweeps each, and
            // nothing is waiting on them.
            for (const key of catalogueSignature.split(',')) {
                if (cancelled) return;
                if (typeCache.current[key]) continue;
                // A failure here is silent by design — the picker surfaces it
                // properly if and when it's actually opened.
                await loadInstanceTypes(key).catch(() => {});
            }
        })();
        return () => { cancelled = true; };
    }, [catalogueSignature, loadInstanceTypes]);

    // Open the instance-type picker for an EC2 instance.
    const openTypeModal = async (inst: EC2Instance) => {
        setTypeModal({ instanceId: inst.id });
        setTypeSelection(inst.instanceType || '');
        setTypeSearch('');
        // Filters from a previous instance would otherwise carry over and hide
        // everything for a machine whose catalogue doesn't have those values.
        setTypeFilters({ vcpus: '', memoryMib: '', network: '' });
        setTypesError('');

        const key = catalogueKeyFor(inst);
        typeRequest.current = key;

        // Already warmed — show it without a loading pass.
        const cached = typeCache.current[key];
        if (cached) {
            setInstanceTypes(cached.types);
            setPricingMeta(cached.pricing);
            return;
        }

        setInstanceTypes(null);
        setPricingMeta(null);
        try {
            const data = await loadInstanceTypes(key);
            // Reopened on a different instance while this was in flight — its
            // catalogue is cached above, it just isn't what's on screen now.
            if (typeRequest.current !== key) return;
            setInstanceTypes(data.types);
            setPricingMeta(data.pricing);
        } catch (err: any) {
            if (typeRequest.current !== key) return;
            setTypesError(err.message || 'Failed to load instance types');
        }
    };

    // Clicking a column header sorts by it; clicking the active one reverses.
    const sortByColumn = (key: TypeSortKey) =>
        setTypeSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

    // Keeps refetching until AWS reports the type we just set. Without this the
    // optimistic value below gets stamped back to the old one by the first stale
    // read, and the modal sits on the previous type until something else happens
    // to refetch — which is exactly what a plain refetch-after-change does.
    const confirmTypeChange = useCallback(async (instanceId: string, instanceType: string) => {
        const deadline = Date.now() + TYPE_CONSISTENCY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, TYPE_CONSISTENCY_POLL_MS));
            try {
                const res = await fetch(`${API_BASE}/instances`);
                if (!res.ok) continue;
                const data: EC2Instance[] = await res.json();
                const reported = data.find(i => i.id === instanceId)?.instanceType;
                // Agreed, or the instance is gone entirely — either way there's
                // nothing left to wait for.
                if (reported === undefined || reported === instanceType) {
                    setInstances(data);
                    settleTransitions(data);
                    return;
                }
            } catch {
                // Keep trying; the optimistic value stands in the meantime.
            }
        }
    }, [settleTransitions]);

    const changeInstanceType = async (instanceId: string, instanceType: string) => {
        setChangingType(true);
        try {
            const res = await fetch(`${API_BASE}/instances/${instanceId}/type`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instanceType })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            // AWS accepted it, so show it straight away rather than waiting for
            // a describe to catch up (see confirmTypeChange).
            setInstances(prev => prev.map(i => i.id === instanceId ? { ...i, instanceType } : i));
            pushToast(`Instance type changed to ${instanceType}`, 'success');
            setTypeModal(null);
            // Reconciles in the background — nothing is waiting on it.
            confirmTypeChange(instanceId, instanceType);
        } catch (err: any) {
            pushToast(`Couldn't change instance type: ${err.message}`, 'error');
        } finally {
            setChangingType(false);
        }
    };

    const handleSaveInstance = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!instanceModal) return;
        const f = instanceForm;
        try {
            if (instanceModal.mode === 'add') {
                await fetch(`${API_BASE}/custom-instances`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: 'custom-' + Date.now(), name: f.name, ip: f.ip, username: f.username, protocol: f.protocol, os: f.os, swapKeys: f.swapKeys, password: f.password })
                });
            } else if (instanceModal.mode === 'edit-custom') {
                await fetch(`${API_BASE}/custom-instances/${instanceModal.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: f.name, ip: f.ip, username: f.username, protocol: f.protocol, os: f.os, swapKeys: f.swapKeys, changePassword: f.changePassword, password: f.password })
                });
            } else if (instanceModal.mode === 'edit-ec2') {
                await fetch(`${API_BASE}/ec2-settings/${instanceModal.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ label: f.name, username: f.username, os: f.os, swapKeys: f.swapKeys, changePassword: f.changePassword, password: f.password })
                });
            }
            await Promise.all([fetchCustomInstances(), fetchInstances()]);
            setInstanceModal(null);
        } catch (err) {
            pushToast('Failed to save instance settings', 'error');
        }
    };

    const handleDeleteCustom = async (id: string) => {
        try {
            await fetch(`${API_BASE}/custom-instances/${id}`, { method: 'DELETE' });
            await fetchCustomInstances();
            if (activeSessions[id]) disconnectInstance(id);
            // Forget its remembered slot too.
            setSessionOrder(prev => prev.filter(x => x !== id));
        } catch (err) {
            pushToast('Failed to delete custom instance', 'error');
        }
    };

    // Confirm before removing a custom instance from the list.
    const confirmDeleteCustom = (inst: CustomInstance) => {
        setConfirm({
            title: 'Remove instance',
            message: `Remove "${inst.name}" from your list? This deletes its saved connection details. EC2 instances are unaffected.`,
            confirmLabel: 'Remove',
            onConfirm: () => handleDeleteCustom(inst.id)
        });
    };

    // A failed session says almost nothing useful on its own — the pane just
    // disappears. guacd (the daemon doing the actual RDP) being down looks
    // exactly like the remote refusing us, so ask the backend which it was.
    const guacdReportedAt = useRef(0);

    // Instance ids are unreadable in a notice, and by the time a deferred one
    // fires the session (which carries the display name) is long gone.
    const labelFor = (instanceId: string) => {
        const inst = instancesRef.current.find(i => i.id === instanceId);
        return activeSessions[instanceId]?.name || inst?.label || inst?.name
            || customInstances.find(c => c.id === instanceId)?.name || instanceId;
    };

    const stateOf = (instanceId: string) => instancesRef.current.find(i => i.id === instanceId)?.state || '';
    const isShuttingDown = (instanceId: string) =>
        !!stoppingRef.current[instanceId] || SHUTTING_DOWN_STATES.includes(stateOf(instanceId));

    // Session errors raised mid-shutdown, waiting to see whether the instance
    // actually gets there. Keyed by instance so a reconnect-and-fail-again
    // replaces its predecessor rather than queueing a second notice.
    const shutdownGrace = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
    useEffect(() => () => Object.values(shutdownGrace.current).forEach(clearTimeout), []);

    const deferSessionError = (instanceId: string, message: string) => {
        clearTimeout(shutdownGrace.current[instanceId]);
        const label = labelFor(instanceId);
        shutdownGrace.current[instanceId] = setTimeout(() => {
            delete shutdownGrace.current[instanceId];
            // Shut down as asked — the dropped session was just the shutdown
            // happening, so there's nothing to report.
            if (STOPPED_STATES.includes(stateOf(instanceId))) return;
            // Still not down a minute on: the reason it gave is worth seeing.
            pushToast(`${label} session ended: ${message}`, 'error');
        }, SHUTDOWN_GRACE_MS);
    };

    const reportSessionError = useCallback(async (instanceId: string, message: string) => {
        // The machine is already gone; a dead session is a consequence, not news.
        if (STOPPED_STATES.includes(stateOf(instanceId))) return;
        // On its way down (a stop we sent, or one made in the console or from
        // inside Windows) — hold the reason until we know it landed.
        if (isShuttingDown(instanceId)) return deferSessionError(instanceId, message);
        const label = labelFor(instanceId);
        try {
            const res = await fetch(`${API_BASE}/guacd`);
            const guacd = await res.json();
            if (!guacd.reachable) {
                // One notice covers every session that just dropped for it.
                if (Date.now() - guacdReportedAt.current < GUACD_TOAST_DEDUPE_MS) return;
                guacdReportedAt.current = Date.now();
                pushToast(guacd.error || 'guacd is unreachable — check that the guacd service is running.', 'error');
                return;
            }
        } catch {
            // The backend itself is unreachable; fall through to the raw reason.
        }
        // A stop may have been requested while we were asking about guacd.
        if (isShuttingDown(instanceId)) return deferSessionError(instanceId, message);
        pushToast(`${label} session ended: ${message}`, 'error');
    }, [activeSessions, customInstances, pushToast]);

    const disconnectInstance = useCallback((instanceId: string) => {
        setActiveSessions(prev => {
            const newSessions = { ...prev };
            delete newSessions[instanceId];
            return newSessions;
        });
        // Keep the id in sessionOrder (just no longer active) so reconnecting
        // restores it to the same slot — e.g. 1,2,3 → disconnect 2 → shows 1,3 →
        // reconnect 2 → reappears between 1 and 3.
    }, []);

    const connectAll = async () => {
        for (const inst of instances) {
            if (inst.state === 'running' && !activeSessions[inst.id]) {
                await connectInstance(inst.id);
            }
        }
        for (const custom of customInstances) {
            if (!activeSessions[custom.id]) {
                await connectInstance(custom.id);
            }
        }
    };

    const disconnectAll = () => {
        // Clear active sessions but keep the remembered order, so reconnecting
        // any of them restores its previous slot.
        setActiveSessions({});
    };

    // Move `fromId` to occupy `toId`'s slot in the grid order.
    const reorderSession = (fromId: string | null, toId: string) => {
        if (!fromId || fromId === toId) return;
        setSessionOrder(prev => {
            const from = prev.indexOf(fromId);
            const to = prev.indexOf(toId);
            if (from === -1 || to === -1) return prev;
            const next = [...prev];
            next.splice(from, 1);
            next.splice(to, 0, fromId);
            return next;
        });
    };

    // Start/stop only *request* a transition — AWS takes a while to actually get
    // there. So the spinner stays up past the API response, and the request is
    // only settled once polling sees the instance arrive (or fail to).
    const startInstances = async (instanceIds: string[]) => {
        if (!instanceIds.length) return;
        setStarting(prev => ({ ...prev, ...beginRequests(instanceIds, instances) }));

        try {
            const res = await fetch(`${API_BASE}/instances/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instanceIds })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            fetchInstances(true);
        } catch (err: any) {
            pushToast(`Failed to start: ${err.message}`, 'error');
            setStarting(prev => dropRequests(prev, instanceIds));
        }
    };

    const stopInstances = async (instanceIds: string[]) => {
        if (!instanceIds.length) return;
        setStopping(prev => ({ ...prev, ...beginRequests(instanceIds, instances) }));

        try {
            const res = await fetch(`${API_BASE}/instances/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instanceIds })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            fetchInstances(true);
        } catch (err: any) {
            pushToast(`Failed to stop: ${err.message}`, 'error');
            setStopping(prev => dropRequests(prev, instanceIds));
        }
    };

    // Every stop action is gated behind a confirmation dialog.
    const confirmStop = (instanceIds: string[], label: string) => {
        if (!instanceIds.length) return;
        const plural = instanceIds.length > 1;
        setConfirm({
            title: plural ? 'Stop instances' : 'Stop instance',
            message: `Stop ${label}? This shuts down the Windows machine${plural ? 's' : ''} and ends any open session${plural ? 's' : ''}.`,
            confirmLabel: plural ? `Stop ${instanceIds.length} instances` : 'Stop',
            onConfirm: () => stopInstances(instanceIds)
        });
    };

    const runningEc2Ids = instances.filter(i => i.state === 'running' && !isStopping(i)).map(i => i.id);
    const stoppedEc2Ids = instances.filter(i => i.state === 'stopped' && !isStarting(i)).map(i => i.id);

    const getGridClass = () => {
        switch (gridLayout) {
            case 1: return 'grid grid-cols-1 auto-rows-fr';
            case 2: return 'grid grid-cols-1 md:grid-cols-2 auto-rows-fr';
            case 3: return 'flex overflow-x-auto snap-x snap-mandatory'; // Horizontal
            case 4: return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 auto-rows-fr';
            default: return 'grid grid-cols-1 auto-rows-fr';
        }
    };

    const activeSessionList = Object.values(activeSessions);
    // Render in explicit drag order; ignore ids no longer connected.
    const orderedSessions = sessionOrder.map(id => activeSessions[id]).filter(Boolean) as ActiveSession[];

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col font-sans relative">
            {!isHeaderVisible && (
                <button
                    onClick={() => setIsHeaderVisible(true)}
                    className="absolute top-0 left-1/2 -translate-x-1/2 bg-slate-800 text-slate-400 hover:text-white px-6 py-1 rounded-b-lg border-b border-x border-slate-700 shadow-xl z-50 opacity-20 hover:opacity-100 transition-all flex items-center justify-center"
                    title="Show Header"
                >
                    <ChevronDown size={20} />
                </button>
            )}

            {/* Header */}
            {isHeaderVisible && (
            <header className="relative bg-slate-900 border-b border-slate-800 p-4 flex justify-between items-center shadow-lg z-10">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => setIsSidebarVisible(!isSidebarVisible)}
                        className="text-slate-400 hover:text-white transition-colors p-1"
                        title="Toggle Sidebar"
                    >
                        {isSidebarVisible ? <PanelLeftClose size={24} /> : <PanelLeftOpen size={24} />}
                    </button>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
                        RDm
                    </h1>
                    <button
                        onClick={connectAll}
                        disabled={loading || instances.length === 0}
                        className="text-sm bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-500/30 px-3 py-1.5 rounded flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                        Connect All
                    </button>
                    <button
                        onClick={disconnectAll}
                        disabled={activeSessionList.length === 0}
                        className="text-sm bg-orange-600/20 text-orange-400 hover:bg-orange-600/30 border border-orange-500/30 px-3 py-1.5 rounded flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                        Disconnect All
                    </button>
                </div>

                <div className="flex items-center gap-2 bg-slate-800 p-1 rounded-lg border border-slate-700">
                    <button
                        onClick={() => changeGridLayout(1)}
                        className={`p-2 rounded transition-colors ${gridLayout === 1 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="Single View"
                    >
                        <Square size={20} />
                    </button>
                    <button
                        onClick={() => changeGridLayout(3)}
                        className={`p-2 rounded transition-colors ${gridLayout === 3 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="Horizontal Scroll"
                    >
                        <GalleryHorizontalEnd size={20} />
                    </button>
                    <button
                        onClick={() => changeGridLayout(2)}
                        className={`p-2 rounded transition-colors ${gridLayout === 2 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="2x2 Grid"
                    >
                        <Grid size={20} />
                    </button>
                    <button
                        onClick={() => changeGridLayout(4)}
                        className={`p-2 rounded transition-colors ${gridLayout === 4 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="4x4 Grid"
                    >
                        <LayoutGrid size={20} />
                    </button>
                    <div className="w-px h-6 bg-slate-700 mx-1"></div>
                    <button
                        onClick={() => setReorderMode(true)}
                        disabled={orderedSessions.length < 2}
                        className={`p-2 rounded transition-colors text-slate-400 hover:text-white hover:bg-slate-700/50 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-400`}
                        title="Reorder sessions"
                    >
                        <ArrowUpDown size={20} />
                    </button>
                    <div className="w-px h-6 bg-slate-700 mx-1"></div>
                    <button
                        onClick={() => { setIsSettingsModalOpen(true); fetchBilling(); }}
                        className="p-2 rounded text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
                        title="Global Settings"
                    >
                        <Settings size={20} />
                    </button>
                </div>

                {/* Minimize tab: sits flush just below the header's bottom edge
                    (top-full) so it reads as a pull-handle instead of floating
                    over the header content. */}
                <button
                    onClick={() => setIsHeaderVisible(false)}
                    className="absolute top-full left-1/2 -translate-x-1/2 bg-slate-800 text-slate-400 hover:text-white px-6 h-5 rounded-b-lg border-b border-x border-slate-700 shadow-md z-20 opacity-40 hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="Hide Header"
                >
                    <ChevronUp size={16} />
                </button>
            </header>
            )}

            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar */}
                {isSidebarVisible && (
                    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col overflow-y-auto shrink-0">
                        <div className="p-4 border-b border-slate-800 flex justify-between items-center">
                            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Active Instances</h2>
                            <button
                                onClick={openAddModal}
                                className="text-slate-400 hover:text-white p-1 bg-slate-800 rounded hover:bg-slate-700 transition-colors"
                                title="Add Custom RDP"
                            >
                                <Plus size={14} />
                            </button>
                        </div>
                    {error && <div className="p-4 text-red-400 text-sm">{error}</div>}
                    <ul className="flex-1 p-2 space-y-1">
                        {customInstances.map(inst => {
                            const isConnected = !!activeSessions[inst.id];
                            return (
                                <li key={inst.id} className={`w-full text-left px-3 py-2 rounded flex flex-col gap-2 group transition-colors ${
                                    isConnected ? 'bg-indigo-600/10 border border-indigo-500/20' : 'hover:bg-slate-800 border border-transparent'
                                }`}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex flex-col truncate">
                                            <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
                                                <span className={`font-medium text-sm truncate ${isConnected ? 'text-indigo-400' : 'text-slate-300'}`}>{inst.name}</span>
                                            </div>
                                            <span className="text-xs opacity-60 truncate font-mono mt-0.5 ml-4">{inst.ip}</span>
                                        </div>
                                        <div className="relative shrink-0">
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => openEditCustom(inst)} title="Instance Settings" className="text-slate-400 hover:text-white p-1"><Settings size={14}/></button>
                                                <button onClick={() => confirmDeleteCustom(inst)} title="Remove" className="text-red-400 hover:text-red-300 p-1"><X size={14}/></button>
                                            </div>
                                            {inst.os && (
                                                <span className="absolute inset-0 flex items-center justify-end text-slate-500 group-hover:opacity-0 transition-opacity pointer-events-none">
                                                    <OsIcon os={inst.os} />
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-end">
                                        <button
                                            onClick={() => isConnected ? disconnectInstance(inst.id) : connectInstance(inst.id)}
                                            disabled={connecting[inst.id]}
                                            className={`px-2 py-1 text-xs rounded border transition-colors flex items-center justify-center min-w-[70px] ${
                                                isConnected ? 'bg-red-500/20 border-red-500/50 text-red-400 hover:bg-red-500/30' : 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400 hover:bg-indigo-500/30 disabled:opacity-50'
                                            }`}
                                        >
                                            {connecting[inst.id] ? <Loader2 size={12} className="animate-spin" /> : (isConnected ? 'Disconnect' : 'Connect')}
                                        </button>
                                    </div>
                                </li>
                            )
                        })}

                        {instances.length > 0 && (
                            <div className="flex items-center justify-between px-2 pt-4 pb-2">
                                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">AWS EC2</span>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => { fetchInstances(); fetchBilling(); }}
                                        disabled={loading}
                                        title="Refresh"
                                        className="p-1 rounded text-blue-400 hover:bg-blue-500/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    >
                                        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                                    </button>
                                    <button
                                        onClick={() => startInstances(stoppedEc2Ids)}
                                        disabled={loading || stoppedEc2Ids.length === 0}
                                        title="Start all stopped instances"
                                        className="p-1 rounded text-green-400 hover:bg-green-500/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    >
                                        <PlayCircle size={16} />
                                    </button>
                                    <button
                                        onClick={() => confirmStop(runningEc2Ids, 'all running instances')}
                                        disabled={loading || runningEc2Ids.length === 0}
                                        title="Stop all running instances"
                                        className="p-1 rounded text-red-400 hover:bg-red-500/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    >
                                        <StopCircle size={16} />
                                    </button>
                                </div>
                            </div>
                        )}
                        {instances.map(inst => {
                            const isConnected = !!activeSessions[inst.id];
                            const isRunning = inst.state === 'running';
                            const displayName = inst.label || inst.name;
                            const busyStarting = isStarting(inst);
                            const busyStopping = isStopping(inst);
                            return (
                                <li key={inst.id} className={`w-full text-left px-3 py-2 rounded flex flex-col gap-2 group transition-colors ${
                                    isConnected
                                    ? 'bg-blue-600/10 border border-blue-500/20'
                                    : 'hover:bg-slate-800 border border-transparent'
                                }`}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex flex-col truncate">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2 h-2 rounded-full ${
                                                    busyStarting || busyStopping ? 'bg-amber-500 animate-pulse' : isRunning ? 'bg-green-500' : 'bg-slate-500'
                                                }`}></span>
                                                <span className={`font-medium text-sm truncate ${isConnected ? 'text-blue-400' : 'text-slate-300'}`}>{displayName}</span>
                                            </div>
                                            <span className="text-xs opacity-60 truncate font-mono mt-0.5 ml-4">{inst.id}</span>
                                        </div>
                                        <div className="relative shrink-0">
                                            <button onClick={() => openEditEc2(inst)} title="Instance Settings" className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-white p-1 transition-opacity"><Settings size={14}/></button>
                                            {inst.os && (
                                                <span className="absolute inset-0 flex items-center justify-center text-slate-500 group-hover:opacity-0 transition-opacity pointer-events-none">
                                                    <OsIcon os={inst.os} />
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between ml-4">
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => startInstances([inst.id])}
                                                title={busyStarting ? 'Starting…' : 'Start EC2'}
                                                disabled={isRunning || busyStarting || busyStopping}
                                                className={`p-1 rounded flex items-center justify-center w-6 h-6 ${isRunning || busyStopping ? 'opacity-30 cursor-not-allowed' : 'hover:bg-green-500/20 text-green-400'}`}
                                            >
                                                {busyStarting ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
                                            </button>
                                            <button
                                                onClick={() => confirmStop([inst.id], displayName)}
                                                title={busyStopping ? 'Stopping…' : 'Stop EC2'}
                                                disabled={!isRunning || busyStopping || busyStarting}
                                                className={`p-1 rounded flex items-center justify-center w-6 h-6 ${!isRunning || busyStarting ? 'opacity-30 cursor-not-allowed' : 'hover:bg-red-500/20 text-red-400'}`}
                                            >
                                                {busyStopping ? <Loader2 size={16} className="animate-spin" /> : <StopCircle size={16} />}
                                            </button>
                                        </div>
                                        <button
                                            onClick={() => isConnected ? disconnectInstance(inst.id) : connectInstance(inst.id)}
                                            disabled={!isRunning || connecting[inst.id]}
                                            title={isConnected ? "Disconnect Viewer" : "Connect Viewer"}
                                            className={`px-2 py-1 text-xs rounded border transition-colors flex items-center justify-center min-w-[70px] ${
                                                !isRunning ? 'opacity-30 cursor-not-allowed border-slate-700' :
                                                isConnected ? 'bg-red-500/20 border-red-500/50 text-red-400 hover:bg-red-500/30' : 'bg-blue-500/20 border-blue-500/50 text-blue-400 hover:bg-blue-500/30'
                                            }`}
                                        >
                                            {connecting[inst.id] ? <Loader2 size={12} className="animate-spin" /> : (isConnected ? 'Disconnect' : 'Connect')}
                                        </button>
                                    </div>
                                </li>
                            )
                        })}
                        {instances.length === 0 && !loading && (
                            <div className="text-center p-4 text-slate-500 text-sm">No active instances found.</div>
                        )}
                    </ul>
                </aside>
                )}

                {/* Main Content - Grid View */}
                <main className="flex-1 bg-black p-4 overflow-y-auto">
                    {orderedSessions.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-slate-500">
                            <Maximize size={48} className="mb-4 opacity-20" />
                            <p className="text-lg">Select an instance to start a session</p>
                        </div>
                    ) : (
                        <div className={`gap-4 h-full ${getGridClass()}`}>
                            {orderedSessions.map(session => {
                                // Resolve name/IP from the live instance lists so a
                                // session restored on page load (before the lists have
                                // finished fetching) still shows the friendly name/IP
                                // instead of the raw instance id. Fall back to whatever
                                // was snapshotted at connect time.
                                const custom = customInstances.find(c => c.id === session.instanceId);
                                const ec2 = instances.find(i => i.id === session.instanceId);
                                const name = custom?.name || ec2?.label || ec2?.name || session.name;
                                const ip = custom?.ip || ec2?.publicIp || ec2?.privateIp || session.ip;
                                const os = custom?.os || ec2?.os || '';
                                const swapCtrlCmd = os === 'macos' && !!(custom?.swapKeys || ec2?.swapKeys);
                                const isDropTarget = dragOverId === session.instanceId && dragId !== session.instanceId;
                                return (
                                <div
                                    key={session.instanceId}
                                    ref={(el) => { gridCellRefs.current[session.instanceId] = el; }}
                                    onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverId !== session.instanceId) setDragOverId(session.instanceId); } }}
                                    onDragLeave={() => { if (dragOverId === session.instanceId) setDragOverId(null); }}
                                    onDrop={(e) => { e.preventDefault(); reorderSession(dragId, session.instanceId); setDragId(null); setDragOverId(null); }}
                                    className={`flex items-center justify-center min-h-[240px] min-w-0 rounded-lg transition-[opacity,transform,box-shadow] duration-150 ease-out ${gridLayout === 3 ? 'min-w-full shrink-0 snap-center h-full' : ''} ${isDropTarget ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-black scale-[1.015]' : ''} ${dragId === session.instanceId ? 'opacity-40 scale-[0.97]' : ''}`}
                                >
                                    <GuacamoleClient
                                        instanceId={session.instanceId}
                                        token={session.token}
                                        name={name}
                                        ip={ip}
                                        protocol={custom?.protocol || 'rdp'}
                                        os={os}
                                        swapCtrlCmd={swapCtrlCmd}
                                        clipboard={sharedClipboard}
                                        onClipboard={publishClipboard}
                                        onDisconnect={() => disconnectInstance(session.instanceId)}
                                        onRefresh={() => refreshInstance(session.instanceId)}
                                        onError={(message) => reportSessionError(session.instanceId, message)}
                                        onReorderDragStart={(e) => { setBlankDragImage(e); setDragId(session.instanceId); }}
                                        onReorderDragEnd={() => { setDragId(null); setDragOverId(null); }}
                                        onFileTransfer={() => setFileTransferPanel({ fromInstanceId: session.instanceId })}
                                    />
                                </div>
                                );
                            })}
                        </div>
                    )}
                </main>
            </div>

            {/* Instance Add / Edit Modal */}
            {instanceModal && (() => {
                const isEc2 = instanceModal.mode === 'edit-ec2';
                const isAdd = instanceModal.mode === 'add';
                const title = isAdd ? 'Add Custom Connection' : isEc2 ? 'EC2 Instance Settings' : 'Instance Settings';
                // Read live rather than from the form: the type is changed
                // through its own modal (an AWS-side action), not saved with the
                // local overrides below.
                const ec2Inst = instanceModal.mode === 'edit-ec2'
                    ? instances.find(i => i.id === instanceModal.id)
                    : undefined;
                return (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
                    <form onSubmit={handleSaveInstance} className="bg-slate-900 border border-slate-700 p-6 rounded-lg shadow-2xl w-full max-w-sm">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-semibold text-white">{title}</h3>
                            <button type="button" onClick={() => setInstanceModal(null)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs text-slate-400 mb-1">Custom Identifier</label>
                                <input required type="text" className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.name} onChange={e => setInstanceForm({...instanceForm, name: e.target.value})} placeholder="Home PC" />
                            </div>
                            <div>
                                <label className="block text-xs text-slate-400 mb-1">IP Address / Hostname</label>
                                <input
                                    required={!isEc2}
                                    disabled={isEc2}
                                    type="text"
                                    className={`w-full border border-slate-700 rounded p-2 outline-none focus:border-blue-500 ${isEc2 ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-slate-950 text-white'}`}
                                    value={instanceForm.ip}
                                    onChange={e => setInstanceForm({...instanceForm, ip: e.target.value})}
                                    placeholder="192.168.1.100"
                                />
                                {isEc2 && <p className="text-xs text-slate-500 mt-1">Managed by AWS — updates automatically.</p>}
                            </div>
                            {!isEc2 && (
                                <div>
                                    <label className="block text-xs text-slate-400 mb-1">Protocol</label>
                                    <select
                                        className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500"
                                        value={instanceForm.protocol}
                                        onChange={e => setInstanceForm({...instanceForm, protocol: e.target.value as 'rdp' | 'vnc'})}
                                    >
                                        <option value="rdp">RDP (port 3389)</option>
                                        <option value="vnc">VNC (port 5900)</option>
                                    </select>
                                    {instanceForm.protocol === 'vnc' && (
                                        <p className="text-xs text-slate-500 mt-1">
                                            Most VNC servers (e.g. UltraVNC) refuse all connections with a blank password — set one below even if the server's real auth is MS-Logon.
                                        </p>
                                    )}
                                </div>
                            )}
                            <div>
                                <label className="block text-xs text-slate-400 mb-1">Operating System</label>
                                <select
                                    className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500"
                                    value={instanceForm.os}
                                    onChange={e => setInstanceForm({...instanceForm, os: e.target.value as '' | 'windows' | 'macos' | 'linux', swapKeys: e.target.value === 'macos' ? instanceForm.swapKeys : false})}
                                >
                                    <option value="">None</option>
                                    <option value="windows">Windows</option>
                                    <option value="macos">macOS</option>
                                    <option value="linux">Linux</option>
                                </select>
                                {instanceForm.os === 'macos' && (
                                    <label className="flex items-center gap-2 text-sm text-slate-300 mt-2 cursor-pointer select-none">
                                        <input type="checkbox" className="w-4 h-4" checked={instanceForm.swapKeys} onChange={e => setInstanceForm({...instanceForm, swapKeys: e.target.checked})} />
                                        Swap Ctrl / Cmd
                                    </label>
                                )}
                            </div>
                            {ec2Inst && (
                                <div>
                                    <label className="block text-xs text-slate-400 mb-1">Instance Type</label>
                                    <button
                                        type="button"
                                        onClick={() => openTypeModal(ec2Inst)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded p-2 flex items-center justify-between hover:border-blue-500 transition-colors group/type"
                                    >
                                        <span className="font-mono text-white">{ec2Inst.instanceType || '—'}</span>
                                        <span className="text-xs text-slate-500 group-hover/type:text-blue-400 flex items-center gap-1">
                                            <Cpu size={13} /> Change
                                        </span>
                                    </button>
                                    <p className="text-xs text-slate-500 mt-1">
                                        {ec2Inst.state === 'stopped'
                                            ? 'Click to view specs and resize the machine.'
                                            : 'Click to view specs — resizing requires the instance to be stopped.'}
                                    </p>
                                </div>
                            )}
                            <div>
                                <label className="block text-xs text-slate-400 mb-1">Username</label>
                                <input required type="text" className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.username} onChange={e => setInstanceForm({...instanceForm, username: e.target.value})} />
                            </div>
                            <div>
                                {isAdd ? (
                                    <>
                                        <label className="block text-xs text-slate-400 mb-1">Password (optional)</label>
                                        <input type="password" className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.password} onChange={e => setInstanceForm({...instanceForm, password: e.target.value})} />
                                    </>
                                ) : (
                                    <>
                                        <label className="flex items-center gap-2 text-sm text-slate-300 mb-2 cursor-pointer select-none">
                                            <input type="checkbox" className="w-4 h-4" checked={instanceForm.changePassword} onChange={e => setInstanceForm({...instanceForm, changePassword: e.target.checked, password: ''})} />
                                            Change password
                                            {instanceForm.hasPassword && !instanceForm.changePassword && <span className="text-xs text-emerald-400/80 ml-1">(a password is saved)</span>}
                                        </label>
                                        {instanceForm.changePassword && (
                                            <input type="password" autoFocus className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.password} onChange={e => setInstanceForm({...instanceForm, password: e.target.value})} placeholder={isEc2 ? 'Leave blank to use key.pem' : 'New password'} />
                                        )}
                                    </>
                                )}
                                {isEc2 && (
                                    <p className="text-xs text-slate-500 mt-1">
                                        For AWS instances the password can be left blank — it's auto-decrypted from your <code className="text-slate-400">key.pem</code> (or <code className="text-slate-400">RDP_PASSWORD</code>). Set one here only to override.
                                    </p>
                                )}
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button type="button" onClick={() => setInstanceModal(null)} className="px-4 py-2 text-sm text-slate-300 hover:text-white">Cancel</button>
                            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">{isAdd ? 'Add Connection' : 'Save'}</button>
                        </div>
                    </form>
                </div>
                );
            })()}

            {/* Instance Type Picker — opened from the EC2 settings modal, so it
                sits above it. Resizing is an AWS-side change applied on its own,
                not part of saving the local overrides underneath. */}
            {typeModal && (() => {
                // Read from the live list so a stop made while this is open
                // clears the "must be stopped" notice on its own.
                const inst = instances.find(i => i.id === typeModal.instanceId);
                const current = inst?.instanceType || '';
                const canResize = inst?.state === 'stopped';
                const all = instanceTypes || [];
                const currentSpec = all.find(t => t.name === current);
                const q = typeSearch.trim().toLowerCase();
                // The current type always stays in view, even if it's an older
                // generation that the filter would otherwise hide.
                const inGeneration = all.filter(t => !currentGenOnly || t.currentGeneration || t.name === current);

                // Dropdown options come from the catalogue in view, so every
                // choice offered leads somewhere — no empty results from picking
                // a size this architecture doesn't have.
                const vcpuOptions = [...new Set(inGeneration.map(t => t.vcpus))]
                    .filter((v): v is number => v !== undefined).sort((a, b) => a - b);
                const memoryOptions = [...new Set(inGeneration.map(t => t.memoryMib))]
                    .filter((v): v is number => v !== undefined).sort((a, b) => a - b);
                // Ordered by throughput rather than alphabetically, so the list
                // reads 'Low' → '100 Gigabit' instead of scattering the figures.
                const networkOptions = [...new Map(
                    inGeneration.filter(t => t.network).map(t => [t.network as string, t.networkGbps])
                )].sort((a, b) => a[1] - b[1]).map(([label]) => label);

                const filtersActive = !!(typeFilters.vcpus || typeFilters.memoryMib || typeFilters.network);
                const matches = inGeneration.filter(t =>
                    (!q || t.name.toLowerCase().includes(q))
                    && (!typeFilters.vcpus || t.vcpus === Number(typeFilters.vcpus))
                    && (!typeFilters.memoryMib || t.memoryMib === Number(typeFilters.memoryMib))
                    && (!typeFilters.network || t.network === typeFilters.network)
                );
                const shown = sortSpecs(matches, typeSort).slice(0, 200);
                const selectedSpec = all.find(t => t.name === typeSelection);
                // What the change would do to the bill, which is usually the
                // actual question behind resizing.
                const hourlyDelta = selectedSpec?.hourly !== undefined && currentSpec?.hourly !== undefined
                    && typeSelection !== current
                    ? selectedSpec.hourly - currentSpec.hourly
                    : undefined;

                // Sortable column header. Called as a function rather than
                // rendered as a component — a component defined inside render is
                // a new type every pass, so React would remount it and the
                // button would lose focus on every sort click. Numeric columns
                // are right-aligned, so there the arrow leads rather than trails.
                const th = (label: string, sortKey: TypeSortKey, align: 'left' | 'right' = 'right', width = '') => {
                    const active = typeSort.key === sortKey;
                    return (
                        <th key={label} className={`${width} font-medium p-0`} aria-sort={active ? (typeSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button
                                type="button"
                                onClick={() => sortByColumn(sortKey)}
                                className={`w-full flex items-center gap-1 px-2 py-2 transition-colors ${align === 'right' ? 'justify-end' : 'justify-start'} ${
                                    active ? 'text-blue-400' : 'text-slate-400 hover:text-white'
                                }`}
                                title={`Sort by ${label.toLowerCase()}`}
                            >
                                {align === 'right' && <SortArrow active={active} dir={typeSort.dir} />}
                                {label}
                                {align === 'left' && <SortArrow active={active} dir={typeSort.dir} />}
                            </button>
                        </th>
                    );
                };

                return (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
                    <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-4xl flex flex-col max-h-[85vh]">
                        <div className="flex justify-between items-start p-6 pb-4 shrink-0">
                            <div>
                                <h3 className="text-lg font-semibold text-white flex items-center gap-2"><Cpu size={18} /> Instance Type</h3>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    {inst ? (inst.label || inst.name) : typeModal.instanceId}
                                    {inst?.architecture && <span className="font-mono ml-2">{inst.architecture}</span>}
                                    {inst?.az && <span className="font-mono ml-2">{inst.az}</span>}
                                </p>
                            </div>
                            <button type="button" onClick={() => setTypeModal(null)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                        </div>

                        {/* Current type, spelled out in full. */}
                        <div className="px-6 shrink-0">
                            <div className="bg-slate-950 border border-slate-700 rounded p-3">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-white text-base">{current || '—'}</span>
                                    <span className="text-xs text-slate-500 uppercase tracking-wider">Current</span>
                                </div>
                                {currentSpec ? (
                                    <>
                                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 mt-2 text-xs">
                                            <div><span className="text-slate-500">vCPU </span><span className="text-slate-300">{currentSpec.vcpus ?? '—'}</span></div>
                                            <div><span className="text-slate-500">Memory </span><span className="text-slate-300">{formatMemory(currentSpec.memoryMib)}</span></div>
                                            <div><span className="text-slate-500">Network </span><span className="text-slate-300">{currentSpec.network || '—'}</span></div>
                                            <div><span className="text-slate-500">Clock </span><span className="text-slate-300">{currentSpec.clockSpeedGhz ? `${currentSpec.clockSpeedGhz} GHz` : '—'}</span></div>
                                            <div><span className="text-slate-500">Storage </span><span className="text-slate-300">{currentSpec.storage}</span></div>
                                            <div><span className="text-slate-500">GPU </span><span className="text-slate-300">{currentSpec.gpu || 'None'}</span></div>
                                        </div>
                                        <div className="flex items-baseline gap-4 mt-2 pt-2 border-t border-slate-800 text-xs">
                                            <span className="text-slate-500">On-demand</span>
                                            <span className="text-emerald-300 tabular-nums">{formatUsd(currentSpec.hourly, 4)}<span className="text-slate-500">/hr</span></span>
                                        </div>
                                    </>
                                ) : (
                                    <p className="text-xs text-slate-500 mt-2">{instanceTypes ? 'Specs unavailable for this type.' : 'Loading specs…'}</p>
                                )}
                            </div>
                        </div>

                        <div className="px-6 pt-4 pb-3 flex items-center gap-3 shrink-0">
                            <input
                                type="text"
                                autoFocus
                                value={typeSearch}
                                onChange={e => setTypeSearch(e.target.value)}
                                placeholder="Filter types — e.g. c5a, xlarge"
                                className="flex-1 bg-slate-950 border border-slate-700 rounded p-2 text-sm text-white outline-none focus:border-blue-500 font-mono"
                            />
                            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none shrink-0">
                                <input type="checkbox" className="w-4 h-4" checked={currentGenOnly} onChange={e => setCurrentGenOnly(e.target.checked)} />
                                Current generation
                            </label>
                        </div>

                        {/* Exact-match spec filters. */}
                        <div className="px-6 pb-3 flex items-center gap-2 flex-wrap shrink-0">
                            {([
                                { key: 'vcpus' as const, label: 'vCPU', options: vcpuOptions.map(v => [String(v), String(v)] as const) },
                                { key: 'memoryMib' as const, label: 'Memory', options: memoryOptions.map(v => [String(v), formatMemory(v)] as const) },
                                { key: 'network' as const, label: 'Network', options: networkOptions.map(v => [v, v] as const) }
                            ]).map(({ key, label, options }) => (
                                <select
                                    key={key}
                                    value={typeFilters[key]}
                                    onChange={e => setTypeFilters({ ...typeFilters, [key]: e.target.value })}
                                    className={`bg-slate-950 border rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500 ${
                                        typeFilters[key] ? 'border-blue-500/60 text-blue-300' : 'border-slate-700 text-slate-400'
                                    }`}
                                >
                                    <option value="">{label}: any</option>
                                    {options.map(([value, text]) => <option key={value} value={value}>{`${label}: ${text}`}</option>)}
                                </select>
                            ))}
                            {filtersActive && (
                                <button
                                    type="button"
                                    onClick={() => setTypeFilters({ vcpus: '', memoryMib: '', network: '' })}
                                    className="text-xs text-slate-400 hover:text-white px-2 py-1.5 flex items-center gap-1"
                                >
                                    <X size={12} /> Clear
                                </button>
                            )}
                            <span className="text-xs text-slate-500 ml-auto tabular-nums">
                                {instanceTypes ? `${matches.length} of ${inGeneration.length} types` : ''}
                            </span>
                        </div>

                        {/* What the cost columns are quoting — rates are per OS
                            and per region, so both matter to reading them. */}
                        {pricingMeta && (
                            <p className="px-6 pb-2 text-xs text-slate-500 shrink-0">
                                {pricingMeta.available ? (
                                    <>On-demand rates for <span className="text-slate-400">{pricingMeta.os}</span> in <span className="text-slate-400 font-mono">{pricingMeta.region}</span>, shared tenancy. Compute only — storage and data transfer are extra.</>
                                ) : (
                                    <span className="text-amber-400/80">Pricing unavailable — the service role needs the <code className="text-amber-300/90">pricing:GetProducts</code> permission.</span>
                                )}
                            </p>
                        )}

                        <div className="flex-1 overflow-y-auto px-6 min-h-[8rem]">
                            {typesError ? (
                                <div className="text-sm text-red-400 py-6 text-center">{typesError}</div>
                            ) : !instanceTypes ? (
                                <div className="flex items-center justify-center gap-2 text-slate-500 py-10 text-sm">
                                    <Loader2 size={16} className="animate-spin" /> Loading instance types…
                                </div>
                            ) : matches.length === 0 ? (
                                <div className="text-sm text-slate-500 py-10 text-center">
                                    {typeSearch || filtersActive
                                        ? 'No instance types match these filters.'
                                        : 'No compatible instance types found.'}
                                </div>
                            ) : (
                                <>
                                    <table className="w-full text-sm border-separate border-spacing-0">
                                        <thead className="sticky top-0 bg-slate-900 z-10">
                                            <tr className="text-xs">
                                                {th('Type', 'name', 'left')}
                                                {th('vCPU', 'vcpus', 'right', 'w-20')}
                                                {th('Memory', 'memoryMib', 'right', 'w-28')}
                                                {th('Network', 'networkGbps', 'right', 'w-36')}
                                                {th('$/hr', 'hourly', 'right', 'w-28')}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {shown.map(t => {
                                                const isCurrent = t.name === current;
                                                const isSelected = t.name === typeSelection;
                                                const cell = `px-2 py-1.5 border-t ${isSelected ? 'border-blue-500/30' : 'border-slate-800'}`;
                                                return (
                                                    <tr
                                                        key={t.name}
                                                        onClick={() => setTypeSelection(t.name)}
                                                        className={`cursor-pointer transition-colors ${
                                                            isSelected ? 'bg-blue-600/15' : 'hover:bg-slate-800/50'
                                                        }`}
                                                    >
                                                        <td className={cell}>
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className={`font-mono ${isSelected ? 'text-blue-300' : 'text-slate-200'}`}>{t.name}</span>
                                                                {isCurrent && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">current</span>}
                                                                {t.burstable && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">burstable</span>}
                                                                {!t.currentGeneration && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 border border-slate-600/40">prev gen</span>}
                                                            </div>
                                                        </td>
                                                        <td className={`${cell} text-right tabular-nums text-slate-300`}>{t.vcpus ?? '—'}</td>
                                                        <td className={`${cell} text-right tabular-nums text-slate-300`}>{formatMemory(t.memoryMib)}</td>
                                                        <td className={`${cell} text-right tabular-nums text-slate-400 text-xs`}>{t.network || '—'}</td>
                                                        <td className={`${cell} text-right tabular-nums text-emerald-300/90`}>{formatUsd(t.hourly, 4)}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    {matches.length > shown.length && (
                                        <p className="text-xs text-slate-500 text-center py-3">
                                            {matches.length - shown.length} more match — narrow the filter to see them.
                                        </p>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="p-6 pt-4 shrink-0 border-t border-slate-800 mt-2">
                            {!canResize && (
                                <p className="text-xs text-amber-400/90 mb-3 flex items-start gap-2">
                                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                                    The instance must be stopped before its type can be changed — it is currently '{inst?.state || 'unknown'}'.
                                </p>
                            )}
                            <div className="flex justify-end items-center gap-3">
                                {hourlyDelta !== undefined && (
                                    <span className={`text-xs mr-auto tabular-nums ${hourlyDelta > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                        {hourlyDelta > 0
                                            ? `Costs ${formatUsd(hourlyDelta, 4)}/hr more than ${current}`
                                            : `Saves ${formatUsd(-hourlyDelta, 4)}/hr against ${current}`}
                                    </span>
                                )}
                                <button type="button" onClick={() => setTypeModal(null)} className="px-4 py-2 text-sm text-slate-300 hover:text-white">Cancel</button>
                                <button
                                    type="button"
                                    onClick={() => changeInstanceType(typeModal.instanceId, typeSelection)}
                                    disabled={!canResize || !typeSelection || typeSelection === current || changingType}
                                    className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
                                >
                                    {changingType && <Loader2 size={14} className="animate-spin" />}
                                    {typeSelection && typeSelection !== current ? `Change to ${typeSelection}` : 'Change type'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                );
            })()}

            {/* Confirmation Dialog */}
            {confirm && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center">
                    <div className="bg-slate-900 border border-slate-700 p-6 rounded-lg shadow-2xl w-full max-w-sm">
                        <div className="flex items-start gap-3 mb-4">
                            <div className="mt-0.5 text-amber-400 shrink-0"><AlertTriangle size={22} /></div>
                            <div>
                                <h3 className="text-lg font-semibold text-white">{confirm.title}</h3>
                                <p className="text-sm text-slate-400 mt-1">{confirm.message}</p>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-slate-300 hover:text-white">Cancel</button>
                            <button
                                onClick={() => { confirm.onConfirm(); setConfirm(null); }}
                                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded flex items-center gap-2"
                            >
                                {confirm.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Global Settings Modal */}
            {isSettingsModalOpen && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
                    <div className="bg-slate-900 border border-slate-700 p-6 rounded-lg shadow-2xl w-full max-w-sm max-h-[85vh] overflow-y-auto">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-semibold text-white">Global Settings</h3>
                            <button onClick={() => setIsSettingsModalOpen(false)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                        </div>
                        <div className="space-y-4">
                            <div className="bg-slate-950 border border-slate-700 rounded p-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <DollarSign size={16} className="text-emerald-400" />
                                        <span className="text-sm text-slate-300">AWS Spend (Month-to-Date)</span>
                                    </div>
                                    <button onClick={fetchBilling} className="text-slate-400 hover:text-white p-1" title="Refresh billing">
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                                <div className="mt-2">
                                    {billing?.available && billing.amount !== undefined ? (
                                        <span className="text-2xl font-bold text-emerald-300 tabular-nums">
                                            {billing.amount.toLocaleString(undefined, { style: 'currency', currency: billing.currency || 'USD' })}
                                        </span>
                                    ) : (
                                        <span className="text-sm text-slate-500">
                                            Unavailable — ensure the service role has the <code className="text-slate-400">ce:GetCostAndUsage</code> permission.
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-slate-500 mt-1">Current statement so far this month, via AWS Cost Explorer. Data can lag a few hours.</p>
                            </div>

                            {/* guacd — the daemon every session is proxied through.
                                Restarting it is the usual fix when sessions stop
                                connecting, so it's controllable from here. */}
                            {(() => {
                                const busy = guacdAction !== null;
                                const ready = guacd !== null;
                                const canControl = ready && guacd.controllable && !busy;
                                const btn = 'flex-1 px-2 py-1.5 text-xs rounded border flex items-center justify-center gap-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
                                return (
                                    <div className="bg-slate-950 border border-slate-700 rounded p-3">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2 h-2 rounded-full ${
                                                    !ready ? 'bg-slate-500' : guacd.reachable ? 'bg-green-500' : 'bg-red-500'
                                                }`}></span>
                                                <span className="text-sm text-slate-300">guacd service</span>
                                            </div>
                                            <button onClick={fetchGuacd} disabled={busy} className="text-slate-400 hover:text-white p-1 disabled:opacity-30" title="Re-check guacd">
                                                <RefreshCw size={14} />
                                            </button>
                                        </div>
                                        <div className="mt-1 text-xs text-slate-500 font-mono">
                                            {!ready ? 'Checking…' : `${guacd.reachable ? 'Running' : 'Not reachable'} — ${guacd.host}:${guacd.port}`}
                                        </div>
                                        <div className="mt-3 flex gap-2">
                                            <button
                                                onClick={() => requestGuacdAction('start')}
                                                disabled={!canControl || guacd.reachable}
                                                className={`${btn} border-green-500/50 bg-green-500/10 text-green-300 hover:bg-green-500/20`}
                                            >
                                                {guacdAction === 'start' ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />} Start
                                            </button>
                                            <button
                                                onClick={() => requestGuacdAction('stop')}
                                                disabled={!canControl || !guacd.reachable}
                                                className={`${btn} border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20`}
                                            >
                                                {guacdAction === 'stop' ? <Loader2 size={13} className="animate-spin" /> : <StopCircle size={13} />} Stop
                                            </button>
                                            <button
                                                onClick={() => requestGuacdAction('restart')}
                                                disabled={!canControl}
                                                className={`${btn} border-blue-500/50 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20`}
                                            >
                                                {guacdAction === 'restart' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Restart
                                            </button>
                                        </div>
                                        <p className="text-xs text-slate-500 mt-2">
                                            {ready && !guacd.controllable
                                                ? 'Service control is disabled on the server (GUACD_SERVICE is unset).'
                                                : 'Proxies every RDP session. Stopping or restarting it ends all open sessions; the instances keep running.'}
                                        </p>
                                    </div>
                                );
                            })()}

                            <div className="flex items-center justify-between">
                                <div>
                                    <label className="block text-sm text-slate-300">Enable Font Smoothing</label>
                                    <p className="text-xs text-slate-500">Improves text clarity drastically (ClearType)</p>
                                </div>
                                <input type="checkbox" checked={globalSettings.fontSmoothing} onChange={e => {
                                    const newSet = {...globalSettings, fontSmoothing: e.target.checked};
                                    setGlobalSettings(newSet);
                                    localStorage.setItem('rdpm_settings', JSON.stringify(newSet));
                                }} className="w-4 h-4" />
                            </div>
                            <div>
                                <label className="block text-sm text-slate-300 mb-1">Color Depth</label>
                                <select
                                    className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500"
                                    value={globalSettings.colorDepth}
                                    onChange={e => {
                                        const newSet = {...globalSettings, colorDepth: e.target.value};
                                        setGlobalSettings(newSet);
                                        localStorage.setItem('rdpm_settings', JSON.stringify(newSet));
                                    }}
                                >
                                    <option value="16">16-bit (Faster)</option>
                                    <option value="24">24-bit (High Color)</option>
                                    <option value="32">32-bit (True Color)</option>
                                </select>
                            </div>
                            <div className="flex items-center justify-between">
                                <div>
                                    <label className="block text-sm text-slate-300">Lossless VNC Colors</label>
                                    <p className="text-xs text-slate-500">Exact color on custom VNC connections, at the cost of speed. Off uses compressed (JPEG-like) tiles — much faster over anything less than a fast LAN.</p>
                                </div>
                                <input type="checkbox" checked={globalSettings.vncLossless} onChange={e => {
                                    const newSet = {...globalSettings, vncLossless: e.target.checked};
                                    setGlobalSettings(newSet);
                                    localStorage.setItem('rdpm_settings', JSON.stringify(newSet));
                                }} className="w-4 h-4" />
                            </div>

                            <div className="border-t border-slate-700 pt-4">
                                <h4 className="text-sm font-semibold text-slate-200 mb-3">Security</h4>

                                <div className="bg-slate-950 border border-slate-700 rounded p-3 flex items-center justify-between">
                                    <div>
                                        <span className="text-sm text-slate-300">Signed in as </span>
                                        <span className="text-sm text-white font-medium">{authStatus.username}</span>
                                    </div>
                                    <button onClick={logout} className="flex items-center gap-1.5 text-xs text-red-300 hover:text-red-200 border border-red-500/50 bg-red-500/10 hover:bg-red-500/20 rounded px-2 py-1.5">
                                        <LogOut size={13} /> Log out
                                    </button>
                                </div>

                                <div className="bg-slate-950 border border-slate-700 rounded p-3 mt-3">
                                    <p className="text-sm text-slate-300 mb-2">Change password</p>
                                    {authStatus.onLan === false ? (
                                        <p className="text-xs text-amber-400/80">Only available from the trusted LAN.</p>
                                    ) : (
                                        <form onSubmit={changePassword} className="space-y-2">
                                            <input type="password" placeholder="Current password" className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white outline-none focus:border-blue-500" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)} required />
                                            <input type="password" placeholder="New password" className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white outline-none focus:border-blue-500" value={pwNew} onChange={e => setPwNew(e.target.value)} minLength={8} required />
                                            <input type="password" placeholder="Confirm new password" className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white outline-none focus:border-blue-500" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} minLength={8} required />
                                            <button type="submit" disabled={pwBusy || !pwCurrent || !pwNew} className="w-full px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded flex items-center justify-center gap-1.5">
                                                {pwBusy && <Loader2 size={12} className="animate-spin" />} Update password
                                            </button>
                                        </form>
                                    )}
                                </div>

                                <div className="bg-slate-950 border border-slate-700 rounded p-3 mt-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            {authStatus.totpEnabled ? <ShieldCheck size={16} className="text-emerald-400" /> : <ShieldOff size={16} className="text-slate-500" />}
                                            <span className="text-sm text-slate-300">Two-factor authentication</span>
                                        </div>
                                        <span className={`text-xs ${authStatus.totpEnabled ? 'text-emerald-400' : 'text-slate-500'}`}>{authStatus.totpEnabled ? 'Enabled' : 'Disabled'}</span>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-1">
                                        Only asked for when signing in from outside the trusted LAN (e.g. over a WireGuard/Tailscale tunnel) — same-LAN logins skip it.
                                    </p>

                                    {authStatus.onLan === false ? (
                                        <p className="text-xs text-amber-400/80 mt-3">Only available from the trusted LAN.</p>
                                    ) : (
                                        <>
                                        {!authStatus.totpEnabled && !totpSetup && (
                                            <button onClick={startTotpSetup} disabled={totpBusy} className="mt-3 w-full px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded flex items-center justify-center gap-1.5">
                                                {totpBusy && <Loader2 size={12} className="animate-spin" />} Enable 2FA
                                            </button>
                                        )}

                                        {totpSetup && (
                                            <form onSubmit={confirmTotpSetup} className="mt-3 space-y-2">
                                                <img src={totpSetup.qr} alt="2FA QR code" className="mx-auto rounded border border-slate-700 bg-white p-1" width={160} height={160} />
                                                <p className="text-xs text-slate-500 text-center break-all">
                                                    Scan with your authenticator app, or enter manually: <code className="text-slate-400">{totpSetup.secret}</code>
                                                </p>
                                                <input
                                                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white text-center tracking-[0.3em] outline-none focus:border-blue-500"
                                                    value={totpCode}
                                                    onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                                    inputMode="numeric"
                                                    maxLength={6}
                                                    placeholder="6-digit code"
                                                    autoFocus
                                                    required
                                                />
                                                <div className="flex gap-2">
                                                    <button type="button" onClick={() => { setTotpSetup(null); setTotpCode(''); }} className="flex-1 px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700 rounded">Cancel</button>
                                                    <button type="submit" disabled={totpBusy || totpCode.length !== 6} className="flex-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded flex items-center justify-center gap-1.5">
                                                        {totpBusy && <Loader2 size={12} className="animate-spin" />} Confirm
                                                    </button>
                                                </div>
                                            </form>
                                        )}

                                        {authStatus.totpEnabled && !showTotpDisable && (
                                            <button onClick={() => setShowTotpDisable(true)} className="mt-3 w-full px-3 py-1.5 text-xs border border-red-500/50 bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded">
                                                Disable 2FA
                                            </button>
                                        )}
                                        {authStatus.totpEnabled && showTotpDisable && (
                                            <form onSubmit={disableTotp} className="mt-3 space-y-2">
                                                <input type="password" placeholder="Confirm your password" className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white outline-none focus:border-blue-500" value={totpDisablePassword} onChange={e => setTotpDisablePassword(e.target.value)} autoFocus required />
                                                <div className="flex gap-2">
                                                    <button type="button" onClick={() => { setShowTotpDisable(false); setTotpDisablePassword(''); }} className="flex-1 px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700 rounded">Cancel</button>
                                                    <button type="submit" disabled={totpBusy} className="flex-1 px-3 py-1.5 text-xs border border-red-500/50 bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded flex items-center justify-center gap-1.5">
                                                        {totpBusy && <Loader2 size={12} className="animate-spin" />} Disable
                                                    </button>
                                                </div>
                                            </form>
                                        )}
                                        </>
                                    )}
                                </div>

                                <div className="bg-slate-950 border border-slate-700 rounded p-3 mt-3">
                                    <label className="block text-sm text-slate-300">Log out after inactivity</label>
                                    <p className="text-xs text-slate-500 mt-0.5">Minutes without mouse/keyboard activity on this page before you're signed out — closing the tab counts the same as going idle. 0 disables it.</p>
                                    <div className="mt-2 flex gap-2">
                                        <input
                                            type="number"
                                            min={0}
                                            max={1440}
                                            className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white outline-none focus:border-blue-500"
                                            value={inactivityMinutes}
                                            onChange={e => setInactivityMinutes(e.target.value)}
                                        />
                                        <button onClick={saveInactivityTimeout} disabled={inactivityBusy} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded flex items-center gap-1.5">
                                            {inactivityBusy && <Loader2 size={12} className="animate-spin" />} Save
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end">
                            <button onClick={() => setIsSettingsModalOpen(false)} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">Done</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Reorder Mode — minimizes every session into compact draggable
                tiles so ordering is easy regardless of the current grid layout. */}
            {reorderMode && (
                <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex flex-col">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
                        <div>
                            <h3 className="text-lg font-semibold text-white flex items-center gap-2"><ArrowUpDown size={18} /> Reorder sessions</h3>
                            <p className="text-xs text-slate-500 mt-0.5">Drag tiles to rearrange. The order is remembered across every layout and reloads.</p>
                        </div>
                        <button onClick={() => setReorderMode(false)} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-2">
                            <Check size={16} /> Done
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6">
                        {orderedSessions.length === 0 ? (
                            <div className="text-center text-slate-500 mt-20">No active sessions to reorder.</div>
                        ) : (
                        <div className="max-w-xl mx-auto flex flex-col gap-2">
                            {orderedSessions.map((session, idx) => {
                                const custom = customInstances.find(c => c.id === session.instanceId);
                                const ec2 = instances.find(i => i.id === session.instanceId);
                                const name = custom?.name || ec2?.label || ec2?.name || session.name;
                                const ip = custom?.ip || ec2?.publicIp || ec2?.privateIp || session.ip;
                                const isDrag = dragId === session.instanceId;
                                const isOver = dragOverId === session.instanceId && !isDrag;
                                return (
                                    <div
                                        key={session.instanceId}
                                        draggable
                                        onDragStart={() => setDragId(session.instanceId)}
                                        onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                                        onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverId !== session.instanceId) setDragOverId(session.instanceId); } }}
                                        onDragLeave={() => { if (dragOverId === session.instanceId) setDragOverId(null); }}
                                        onDrop={(e) => { e.preventDefault(); reorderSession(dragId, session.instanceId); setDragId(null); setDragOverId(null); }}
                                        className={`flex items-center gap-3 rounded-lg border px-4 py-3 bg-slate-900 cursor-grab active:cursor-grabbing transition-all duration-200 ease-out
                                            ${isDrag ? 'opacity-40 scale-[0.98]' : 'hover:border-slate-600'}
                                            ${isOver ? 'border-blue-400 ring-1 ring-blue-400 translate-x-1' : 'border-slate-700'}`}
                                    >
                                        <GripVertical size={18} className="text-slate-500 shrink-0" />
                                        <span className="w-6 text-center text-xs font-mono text-slate-500 shrink-0">{idx + 1}</span>
                                        <div className="flex flex-col truncate">
                                            <span className="text-sm font-medium text-slate-200 truncate">{name}</span>
                                            {ip && <span className="text-xs text-slate-500 font-mono truncate">{ip}</span>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        )}
                    </div>
                </div>
            )}

            {/* File transfer panel */}
            {fileTransferPanel && (
                <FileTransferPanel
                    sessions={orderedSessions.map(s => {
                    const custom = customInstances.find(c => c.id === s.instanceId);
                    const ec2 = instances.find(i => i.id === s.instanceId);
                    const name = custom?.name || ec2?.label || ec2?.name || s.name;
                    return { instanceId: s.instanceId, name };
                })}
                    fromInstanceId={fileTransferPanel.fromInstanceId}
                    apiBase={API_BASE}
                    onClose={() => setFileTransferPanel(null)}
                />
            )}

            {/* Toast notifications */}
            {toasts.length > 0 && (
                <div className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
                    {toasts.map(t => (
                        <div
                            key={t.id}
                            role="alert"
                            className={`toast-in flex items-start gap-3 rounded-lg border px-4 py-3 shadow-2xl ${
                                t.type === 'error' ? 'bg-red-950/95 border-red-500/40 text-red-100'
                                : t.type === 'success' ? 'bg-emerald-950/95 border-emerald-500/40 text-emerald-100'
                                : 'bg-slate-900/95 border-slate-600 text-slate-100'
                            }`}
                        >
                            <div className="mt-0.5 shrink-0">
                                {t.type === 'error' ? <AlertTriangle size={18} className="text-red-400" /> : <Check size={18} className="text-emerald-400" />}
                            </div>
                            <p className="text-sm flex-1 break-words">{t.message}</p>
                            <button onClick={() => dismissToast(t.id)} className="opacity-60 hover:opacity-100 shrink-0"><X size={16} /></button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default App;
