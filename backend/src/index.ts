/// <reference path="./guacamole-lite.d.ts" />
import express from 'express';
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, DescribeInstanceTypesCommand, DescribeInstanceTypeOfferingsCommand, ModifyInstanceAttributeCommand } from '@aws-sdk/client-ec2';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import GuacamoleLite from 'guacamole-lite';
import { startSSMTunnel } from './ssmTunnel';
import { getWindowsPassword } from './passwordDecrypt';
import { initDb, addCustomInstance, updateCustomInstance, getCustomInstances, deleteCustomInstance, getCustomInstance, getAllEc2Settings, getEc2SettingFull, upsertEc2Setting } from './db';
import { authRouter, requireAuth } from './auth';
// @ts-ignore
import Crypt from 'guacamole-lite/lib/Crypt';

dotenv.config();

const app = express();

// Unset by default — req.ip (used by TRUSTED_LAN_CIDRS, see network.ts) then
// reflects the raw TCP source address, ignoring X-Forwarded-For entirely
// (untrusted and spoofable coming from the open internet). Only set this if
// the app is deployed behind the optional reverse proxy AND that proxy is
// configured to set X-Forwarded-For itself — see the README's "Behind a
// reverse proxy" section. Typically "loopback" (proxy on the same host).
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY);
}

// Optional built-in TLS so the app can run standalone over HTTPS — needed for
// browser clipboard sync (secure context) — without a reverse proxy in front.
// Point TLS_CERT/TLS_KEY at a cert + key (self-signed, mkcert, or a real cert);
// with neither set it serves plain HTTP. guacamole-lite attaches to whichever
// server is created below, so the WebSocket follows the same scheme (ws/wss).
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
let server: http.Server | https.Server;
if (TLS_CERT && TLS_KEY) {
    server = https.createServer(
        { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
        app
    );
    console.log('TLS enabled — serving HTTPS/WSS');
} else {
    server = http.createServer(app);
}

// Built by `npm run build` in ../frontend; nginx proxies /rdm/ straight to
// this service (see ../../deploy.json), so the SPA is served from here too.
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');

// `credentials: true` + reflecting the request origin (rather than `*`) is
// required for the session cookie to work cross-origin in dev mode (the Vite
// dev server runs on its own port). In the documented standalone/proxy
// deployments the frontend and API share an origin, so this is a no-op there.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Auth routes are mostly public (login/setup/status) with their own rules;
// every other /api/* route requires a session. Registration order matters —
// requireAuth must come after authRouter so /api/auth/* isn't gated by it.
app.use('/api/auth', authRouter);
app.use('/api', requireAuth);

const ec2 = new EC2Client({});
// Cost Explorer is a global service that only lives in us-east-1.
const costExplorer = new CostExplorerClient({ region: 'us-east-1' });
// The Price List API is likewise only served from a few endpoints; us-east-1
// carries pricing for every region, so the region being priced is a filter
// rather than the endpoint.
const pricing = new PricingClient({ region: 'us-east-1' });

// Key must be exactly 32 bytes for AES-256-CBC
const GUAC_CRYPT_KEY = process.env.GUAC_CRYPT_KEY || 'MySuperSecretKeyForGuacamoleLite';
const GUAC_CRYPT_CYPHER = 'AES-256-CBC';
const USE_SSM_TUNNEL = process.env.USE_SSM_TUNNEL === 'true';

// Root directory for Guacamole virtual drive staging areas. One sub-directory
// per instance ID; guacd maps each into Windows as the "RDM Transfer" drive.
// DRIVES_DIR is the host path used by the file API (list/copy/delete).
// GUAC_DRIVES_DIR is the path guacd sees — set this to the container-side
// mount point when guacd runs in Docker (e.g. /rdm-drives).
const DRIVES_DIR = process.env.DRIVES_DIR || path.join(__dirname, '..', '..', 'rdm-drives');
const GUAC_DRIVES_DIR = process.env.GUAC_DRIVES_DIR || DRIVES_DIR;


app.get('/api/instances', async (req, res) => {
    try {
        const cmd = new DescribeInstancesCommand({
            Filters: [
                { Name: 'instance-state-name', Values: ['running', 'stopped', 'pending', 'stopping'] }
            ]
        });
        const response = await ec2.send(cmd);
        // Stored per-EC2 overrides (custom identifier / username / whether a
        // password is saved), merged into each discovered instance.
        const overrides = await getAllEc2Settings();
        const instances = [];

        for (const reservation of (response.Reservations || [])) {
            for (const instance of (reservation.Instances || [])) {
                // Find Name tag
                const nameTag = instance.Tags?.find(t => t.Key === 'Name');
                const ov = instance.InstanceId ? overrides[instance.InstanceId] : undefined;
                instances.push({
                    id: instance.InstanceId,
                    name: nameTag ? nameTag.Value : instance.InstanceId,
                    // User-set custom identifier override (falls back to the AWS
                    // Name tag in the UI when empty).
                    label: ov?.label || '',
                    username: ov?.username || '',
                    hasPassword: ov?.hasPassword || false,
                    os: ov?.os || '',
                    swapKeys: ov?.swapKeys || false,
                    state: instance.State?.Name,
                    // Hardware size (e.g. 'c5a.xlarge'), changeable from the
                    // instance settings modal while the instance is stopped.
                    instanceType: instance.InstanceType,
                    // A resize is constrained by both of these — the picker
                    // filters its catalogue to types that support the same
                    // architecture and are offered in the instance's own AZ.
                    architecture: instance.Architecture,
                    az: instance.Placement?.AvailabilityZone,
                    // The OS the AMI carries ('Windows', 'Linux/UNIX', …). On-demand
                    // rates differ by OS, so this decides which price list applies.
                    platformDetails: instance.PlatformDetails,
                    // Why the instance is in that state (e.g.
                    // 'Server.InsufficientInstanceCapacity',
                    // 'Client.UserInitiatedShutdown'). AWS keeps the previous
                    // reason until the state actually changes, which is what
                    // lets the UI tell a failed start from one still in flight.
                    stateReasonCode: instance.StateReason?.Code || '',
                    stateReasonMessage: instance.StateReason?.Message || '',
                    privateIp: instance.PrivateIpAddress,
                    publicIp: instance.PublicIpAddress
                });
            }
        }
        
        // Sort by name
        instances.sort((a, b) => a.name!.localeCompare(b.name!));
        
        res.json(instances);
    } catch (err: any) {
        console.error('Error fetching instances:', err);
        res.status(500).json({ error: err.message });
    }
});

// Month-to-date AWS spend, shown in the header. Cost Explorer data can lag a
// few hours and requires the `ce:GetCostAndUsage` IAM permission, so any
// failure is reported as `available: false` rather than breaking the header.
app.get('/api/billing', async (req, res) => {
    try {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        // First day of the current month (UTC).
        const start = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
        // End is exclusive; use tomorrow so today's partial spend is included.
        const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const end = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}`;

        const cmd = new GetCostAndUsageCommand({
            TimePeriod: { Start: start, End: end },
            Granularity: 'MONTHLY',
            Metrics: ['UnblendedCost']
        });
        const response = await costExplorer.send(cmd);

        // Sum all buckets in the range (there may be more than one if the range
        // straddles a month boundary near midnight UTC).
        let amount = 0;
        let currency = 'USD';
        for (const bucket of (response.ResultsByTime || [])) {
            const cost = bucket.Total?.UnblendedCost;
            if (cost?.Amount) amount += parseFloat(cost.Amount);
            if (cost?.Unit) currency = cost.Unit;
        }

        res.json({ available: true, amount, currency, periodStart: start });
    } catch (err: any) {
        console.error('Error fetching billing:', err);
        res.json({ available: false, error: err.message });
    }
});

// Configure Guacamole Lite
const guacOptions = {
    crypt: {
        cypher: GUAC_CRYPT_CYPHER,
        key: GUAC_CRYPT_KEY
    },
    // 'DEBUG' logs every ping/nop frame on every connection — it filled a log
    // with gigabytes of noise. 'NORMAL' keeps connect/disconnect/errors only.
    log: {
        level: 'NORMAL'
    }
};

// guacd is the Guacamole proxy daemon that does the actual RDP; this service
// only brokers tokens and WebSockets. If it isn't running, the WebSocket opens
// and then dies without ever explaining itself, so it gets probed directly (see
// probeGuacd) and reported as its own error.
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number(process.env.GUACD_PORT) || 4822;
const GUACD_PROBE_TIMEOUT_MS = 2000;

const guacClientOptions = {
    host: GUACD_HOST,
    port: GUACD_PORT
};

// Opens and immediately drops a TCP connection to guacd. Enough to tell "not
// running / not reachable" from "running but the RDP target is refusing us",
// which are otherwise indistinguishable once the tunnel has been handed off.
const probeGuacd = () => new Promise<{ reachable: boolean; error?: string }>(resolve => {
    const socket = net.createConnection({ host: GUACD_HOST, port: GUACD_PORT });
    const settle = (result: { reachable: boolean; error?: string }) => {
        socket.destroy();
        resolve(result);
    };
    socket.setTimeout(GUACD_PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle({ reachable: true }));
    socket.once('timeout', () => settle({ reachable: false, error: `no response within ${GUACD_PROBE_TIMEOUT_MS}ms` }));
    socket.once('error', (err: NodeJS.ErrnoException) => settle({ reachable: false, error: err.code || err.message }));
});

const guacdUnreachableMessage = (error?: string) =>
    `guacd is unreachable at ${GUACD_HOST}:${GUACD_PORT}${error ? ` (${error})` : ''} — check that the guacd service is running.`;

// Waits for guacd to actually reach the state an action asked for, so the UI
// reports what happened instead of what was requested — a restart in particular
// is unreachable for a moment in the middle.
const waitForGuacd = async (expectReachable: boolean, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    let probe = await probeGuacd();
    while (probe.reachable !== expectReachable && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 300));
        probe = await probeGuacd();
    }
    return probe;
};

const execFileAsync = promisify(execFile);

// Service control for guacd. `<cmd> <action> <service>` — which suits the
// documented Docker setup as-is (`docker restart guacd`) and equally a systemd
// unit via GUACD_SERVICE_CMD='sudo -n systemctl'. Leaving GUACD_SERVICE blank
// disables control entirely. The action is always one of three fixed verbs and
// the service name comes from config, so nothing from a request ever reaches the
// command line — and execFile takes an argv, not a shell string.
const GUACD_SERVICE = process.env.GUACD_SERVICE ?? 'guacd';
const GUACD_SERVICE_CMD = process.env.GUACD_SERVICE_CMD || 'docker';
const GUACD_ACTIONS = ['start', 'stop', 'restart'];
// A `docker stop` waits out a 10s SIGTERM grace period, and a restart does that
// then starts again, so this has to sit comfortably past both.
const GUACD_ACTION_TIMEOUT_MS = 30000;

const guacdStatus = (probe: { reachable: boolean; error?: string }) => ({
    reachable: probe.reachable,
    host: GUACD_HOST,
    port: GUACD_PORT,
    // Whether the Start/Stop/Restart controls can do anything on this host.
    controllable: !!GUACD_SERVICE,
    service: GUACD_SERVICE,
    error: probe.reachable ? undefined : guacdUnreachableMessage(probe.error)
});

// Polled by the frontend when a session dies, to say whether guacd was the
// reason rather than the remote desktop itself.
app.get('/api/guacd', async (req, res) => {
    res.json(guacdStatus(await probeGuacd()));
});

app.post('/api/guacd/:action', async (req, res) => {
    const { action } = req.params;
    if (!GUACD_ACTIONS.includes(action)) {
        return res.status(400).json({ error: `Unsupported action '${action}'` });
    }
    if (!GUACD_SERVICE) {
        return res.status(501).json({ error: 'guacd service control is disabled on this host (GUACD_SERVICE is unset).' });
    }

    const [cmd, ...prefixArgs] = GUACD_SERVICE_CMD.split(/\s+/).filter(Boolean);
    if (!cmd) {
        return res.status(501).json({ error: 'guacd service control is misconfigured (GUACD_SERVICE_CMD is empty).' });
    }
    try {
        await execFileAsync(cmd, [...prefixArgs, action, GUACD_SERVICE], { timeout: GUACD_ACTION_TIMEOUT_MS });
    } catch (err: any) {
        // stderr is where the useful part lives — a missing sudoers rule, an
        // unknown unit — so pass it through rather than a generic failure.
        const detail = (err.stderr || err.message || '').toString().trim();
        console.error(`Error running '${action}' on ${GUACD_SERVICE}:`, detail);
        return res.status(500).json({ error: `Couldn't ${action} ${GUACD_SERVICE}: ${detail}` });
    }

    const probe = await waitForGuacd(action !== 'stop');
    res.json({ ...guacdStatus(probe), action });
});

// Constructing GuacamoleLite attaches the WebSocket handler to `server`; we
// don't need the returned instance (tokens are encrypted directly below).
new GuacamoleLite(
    { server },
    guacClientOptions,
    guacOptions,
    {}
);

app.get('/api/custom-instances', async (req, res) => {
    try {
        const instances = await getCustomInstances();
        res.json(instances);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/custom-instances', async (req, res) => {
    try {
        const { id, name, ip, username, password, protocol, os, swapKeys } = req.body;
        await addCustomInstance(id, name, ip, username, password, protocol || 'rdp', os || '', !!swapKeys);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/custom-instances/:id', async (req, res) => {
    try {
        const { name, ip, username, protocol, os, swapKeys, changePassword, password } = req.body;
        await updateCustomInstance(req.params.id, { name, ip, username, protocol: protocol || 'rdp', os: os || '', swapKeys: !!swapKeys, changePassword, password });
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/custom-instances/:id', async (req, res) => {
    try {
        await deleteCustomInstance(req.params.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Save per-EC2 overrides (custom identifier, RDP username, optional password).
// Leaving the password blank means "use key.pem / RDP_PASSWORD" at connect time.
app.put('/api/ec2-settings/:id', async (req, res) => {
    try {
        const { label, username, os, swapKeys, changePassword, password } = req.body;
        await upsertEc2Setting(req.params.id, { label, username, os, swapKeys, changePassword, password });
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/connect', async (req, res) => {
    try {
        // Checked before any of the work below, so a stopped guacd is reported as
        // itself instead of as a session that opens and instantly vanishes.
        const probe = await probeGuacd();
        if (!probe.reachable) {
            return res.status(503).json({ error: guacdUnreachableMessage(probe.error) });
        }

        const { instanceId, customId, settings = {} } = req.body;

        let rdpHostname = '';
        let rdpPort = 3389;
        let dynamicPassword = '';
        let username = process.env.AWS_RDP_USERNAME || 'Administrator';
        // EC2 instances are always RDP (Windows Server, password via
        // GetPasswordData) — only a custom instance can be VNC.
        let protocol = 'rdp';

        if (customId) {
            const custom = await getCustomInstance(customId);
            if (!custom) {
                return res.status(404).json({ error: 'Custom instance not found' });
            }
            rdpHostname = custom.ip;
            dynamicPassword = custom.password || '';
            username = custom.username || 'Administrator';
            protocol = custom.protocol || 'rdp';
            if (protocol === 'vnc') rdpPort = 5900;
        } else if (instanceId) {
            if (USE_SSM_TUNNEL) {
                rdpPort = await startSSMTunnel(instanceId);
                rdpHostname = '127.0.0.1';
            } else {
                const describeCmd = new DescribeInstancesCommand({
                    InstanceIds: [instanceId]
                });
                const ec2Res = await ec2.send(describeCmd);
                const inst = ec2Res.Reservations?.[0]?.Instances?.[0];

                if (!inst) {
                    return res.status(404).json({ error: 'Instance not found' });
                }

                rdpHostname = inst.PublicIpAddress || inst.PrivateIpAddress || '';
                if (!rdpHostname) {
                    return res.status(400).json({ error: 'Instance has no IP address' });
                }
            }

            // Per-instance overrides take priority: an explicit username and/or
            // a saved password entered in the instance settings modal.
            const ec2Setting = await getEc2SettingFull(instanceId);
            if (ec2Setting?.username) username = ec2Setting.username;

            if (ec2Setting?.password) {
                // User supplied a password explicitly — use it as-is.
                dynamicPassword = ec2Setting.password;
            } else {
                // Blank password → auto-decrypt via key.pem, else RDP_PASSWORD.
                const fetchedPassword = await getWindowsPassword(ec2, instanceId);
                dynamicPassword = fetchedPassword || process.env.RDP_PASSWORD || '';
            }
        } else {
            return res.status(400).json({ error: 'Missing instanceId or customId' });
        }
        
        // Prepare Guacamole connection settings for this tunnel. RDP and VNC
        // take different parameter sets — VNC has no NLA/theming/composition
        // concept, and the server (not the client) dictates its own
        // resolution, so width/height don't apply.
        const connectionSettings = protocol === 'vnc' ? {
            connection: {
                type: 'vnc',
                settings: {
                    hostname: rdpHostname,
                    port: rdpPort.toString(),
                    // Sent for UltraVNC MS-Logon (username+password); ignored
                    // by servers using plain VNC password auth.
                    username: username,
                    password: dynamicPassword || '',
                    // Default (local) renders the cursor client-side from a
                    // bitmap+mask UltraVNC sends — its mask format and
                    // Guacamole's interpretation of it disagree, leaving the
                    // "transparent" area a solid pink/magenta. Remote bakes
                    // the cursor into the screen image server-side instead,
                    // sidestepping the mismatch entirely (slightly less
                    // snappy cursor movement, irrelevant for this use case).
                    cursor: 'remote',
                    // Otherwise guacd is free to send a SetDesktopSize
                    // request matching whatever pixel size the grid pane
                    // currently renders at, and UltraVNC honors it — which
                    // is what's been forcing the real Windows resolution
                    // down to match the pane instead of staying at whatever
                    // was set locally.
                    'disable-display-resize': 'true',
                    'color-depth': settings.colorDepth || '32',
                    // Lossless (raw) encoding gives exact color but sends far
                    // more data per frame than RDP's path ever does — over
                    // anything less than a fast LAN it's the main source of
                    // the "VNC is laggier than RDP" feel. Default to letting
                    // guacd use its lossy JPEG-style tile compression instead;
                    // 'vncLossless' opts back into exact color for those who
                    // want it and have the bandwidth.
                    'force-lossless': settings.vncLossless ? 'true' : 'false',
                    ...(settings.vncLossless ? {} : { 'compress-level': '6', 'quality-level': '6' })
                }
            }
        } : {
            connection: {
                type: 'rdp',
                settings: {
                    hostname: rdpHostname,
                    port: rdpPort.toString(),
                    username: username,
                    password: dynamicPassword || '',
                    security: 'nla',
                    'ignore-cert': 'true',
                    width: '1920',
                    height: '1080',
                    'color-depth': settings.colorDepth || '32',
                    'enable-font-smoothing': settings.fontSmoothing !== false ? 'true' : 'false',
                    'enable-theming': 'true',
                    'enable-desktop-composition': 'true',
                    'enable-wallpaper': 'true',
                    // Virtual drive: Windows sees this as a mapped "RDM Transfer"
                    // drive in Explorer. Files dropped there land in DRIVES_DIR
                    // and can be copied to any other connected server's staging dir.
                    'enable-drive': 'true',
                    'drive-name': 'RDM Transfer',
                    'drive-path': path.join(GUAC_DRIVES_DIR, instanceId || customId || 'unknown'),
                    'create-drive-path': 'true'
                }
            }
        };

        // Encrypt the connection settings into a token
        const tokenCrypt = new Crypt(GUAC_CRYPT_CYPHER, GUAC_CRYPT_KEY);
        const token = tokenCrypt.encrypt(connectionSettings);
        
        res.json({ token, instanceId: instanceId || customId, port: rdpPort });
    } catch (err: any) {
        console.error('Error connecting:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/instances/start', async (req, res) => {
    const { instanceIds } = req.body;
    if (!instanceIds || !instanceIds.length) return res.status(400).json({ error: 'No instance IDs provided' });
    try {
        const cmd = new StartInstancesCommand({ InstanceIds: instanceIds });
        await ec2.send(cmd);
        res.json({ success: true });
    } catch (err: any) {
        console.error('Error starting instances:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/instances/stop', async (req, res) => {
    const { instanceIds } = req.body;
    if (!instanceIds || !instanceIds.length) return res.status(400).json({ error: 'No instance IDs provided' });
    try {
        const cmd = new StopInstancesCommand({ InstanceIds: instanceIds });
        await ec2.send(cmd);
        res.json({ success: true });
    } catch (err: any) {
        console.error('Error stopping instances:', err);
        res.status(500).json({ error: err.message });
    }
});

// The catalogue of instance types, trimmed to the specs worth choosing between.
// It takes several paginated calls to assemble and doesn't meaningfully change
// while the process is up, so each architecture + AZ combination is built once
// and kept.
interface InstanceTypeSpec {
    name: string;
    vcpus: number | undefined;
    memoryMib: number | undefined;
    // AWS's own wording — 'Up to 10 Gigabit', '25 Gigabit', etc.
    network: string | undefined;
    // Numeric form of `network`, so the column can be sorted. AWS states it as
    // prose ('Up to 10 Gigabit', 'Moderate'), which sorts meaninglessly as text.
    networkGbps: number;
    clockSpeedGhz: number | undefined;
    // On-demand USD/hour for the OS being priced; undefined when the Price List
    // API had no rate for the type (or the lookup wasn't permitted).
    hourly: number | undefined;
    architectures: string[];
    currentGeneration: boolean;
    burstable: boolean;
    storage: string;
    gpu: string | undefined;
}

const instanceTypeCache = new Map<string, Promise<InstanceTypeSpec[]>>();

// AWS describes network throughput in prose. The smaller types get adjectives
// rather than a figure; these are the rough equivalents AWS documents, which is
// enough to order the column sensibly.
const NETWORK_WORDS: Record<string, number> = {
    'very low': 0.1,
    'low': 0.25,
    'low to moderate': 0.4,
    'moderate': 0.5,
    'high': 1,
    'very high': 2
};

const networkToGbps = (performance?: string): number => {
    if (!performance) return 0;
    const text = performance.toLowerCase();
    const figure = text.match(/([\d.]+)\s*(giga|mega)bit/);
    if (figure?.[1]) {
        const value = parseFloat(figure[1]) / (figure[2] === 'mega' ? 1000 : 1);
        // 'Up to 10 Gigabit' is burstable, not sustained — sort it just under a
        // type that actually guarantees the same figure.
        return text.startsWith('up to') ? value - 0.001 : value;
    }
    return NETWORK_WORDS[text] ?? 0;
};

// On-demand rates are per OS, so the instance's own platform decides which price
// list to read. AWS words these differently in DescribeInstances and in the
// Price List API, hence the translation.
const PLATFORM_PRICING: Record<string, { os: string; sw: string }> = {
    'Linux/UNIX': { os: 'Linux', sw: 'NA' },
    'Red Hat Enterprise Linux': { os: 'RHEL', sw: 'NA' },
    'Red Hat Enterprise Linux with HA': { os: 'RHEL', sw: 'NA' },
    'SUSE Linux': { os: 'SUSE', sw: 'NA' },
    'Windows': { os: 'Windows', sw: 'NA' },
    'Windows with SQL Server Standard': { os: 'Windows', sw: 'SQL Std' },
    'Windows with SQL Server Web': { os: 'Windows', sw: 'SQL Web' },
    'Windows with SQL Server Enterprise': { os: 'Windows', sw: 'SQL Ent' }
};

const pricingFiltersFor = (platformDetails: string) =>
    PLATFORM_PRICING[platformDetails]
    // Anything unrecognised is priced as plain Linux or Windows — wrong for an
    // exotic AMI, but closer than showing nothing at all.
    ?? (/windows/i.test(platformDetails) ? { os: 'Windows', sw: 'NA' } : { os: 'Linux', sw: 'NA' });

// USD/hour per instance type for one region + OS. Rates change rarely and the
// full list is dozens of paginated calls, so it's fetched once and kept.
const pricingCache = new Map<string, Promise<Map<string, number>>>();

const describePricing = async (region: string, platformDetails: string): Promise<Map<string, number>> => {
    const { os, sw } = pricingFiltersFor(platformDetails);
    const rates = new Map<string, number>();
    let token: string | undefined;
    do {
        const res = await pricing.send(new GetProductsCommand({
            ServiceCode: 'AmazonEC2',
            Filters: [
                { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
                { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: os },
                { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: sw },
                // Shared tenancy on normal (non-reserved) capacity — i.e. what an
                // ordinary on-demand instance is billed at.
                { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
                { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
                { Type: 'TERM_MATCH', Field: 'licenseModel', Value: 'No License required' }
            ],
            MaxResults: 100,
            NextToken: token
        }));
        for (const entry of res.PriceList || []) {
            // These arrive as JSON *strings* — and as boxed String objects
            // rather than primitives, so a `typeof === 'string'` test misses
            // them and hands back the wrapper instead of the parsed product.
            const raw: any = entry;
            const product = typeof raw?.product === 'object' ? raw : JSON.parse(raw.toString());
            const type = product?.product?.attributes?.instanceType;
            if (!type || rates.has(type)) continue;
            for (const term of Object.values<any>(product.terms?.OnDemand || {})) {
                for (const dim of Object.values<any>(term?.priceDimensions || {})) {
                    if (dim?.unit !== 'Hrs') continue;
                    const usd = parseFloat(dim?.pricePerUnit?.USD);
                    // Free-tier and placeholder records price at 0; a real rate
                    // is what's wanted here.
                    if (usd > 0) { rates.set(type, usd); break; }
                }
                if (rates.has(type)) break;
            }
        }
        token = res.NextToken;
    } while (token);
    return rates;
};

const getPricing = (region: string, platformDetails: string) => {
    const key = `${region}|${platformDetails}`;
    let pending = pricingCache.get(key);
    if (!pending) {
        pending = describePricing(region, platformDetails);
        pricingCache.set(key, pending);
        pending.catch(() => pricingCache.delete(key));
    }
    return pending;
};

// Which types an AZ actually offers. A type can exist region-wide and still be
// absent from the AZ the instance sits in — resizing into one of those leaves a
// machine that won't start again, so they're kept out of the picker entirely.
const describeOfferedTypes = async (az: string): Promise<Set<string>> => {
    const offered = new Set<string>();
    let token: string | undefined;
    do {
        const res = await ec2.send(new DescribeInstanceTypeOfferingsCommand({
            LocationType: 'availability-zone',
            Filters: [{ Name: 'location', Values: [az] }],
            MaxResults: 1000,
            NextToken: token
        }));
        for (const o of res.InstanceTypeOfferings || []) {
            if (o.InstanceType) offered.add(o.InstanceType);
        }
        token = res.NextToken;
    } while (token);
    return offered;
};

const describeInstanceTypes = async (arch: string, az: string): Promise<InstanceTypeSpec[]> => {
    const offered = az ? await describeOfferedTypes(az) : null;
    const specs: InstanceTypeSpec[] = [];
    let token: string | undefined;
    do {
        const res = await ec2.send(new DescribeInstanceTypesCommand({
            MaxResults: 100,
            NextToken: token,
            Filters: arch ? [{ Name: 'processor-info.supported-architecture', Values: [arch] }] : undefined
        }));
        for (const t of res.InstanceTypes || []) {
            if (!t.InstanceType) continue;
            if (offered && !offered.has(t.InstanceType)) continue;
            const disks = t.InstanceStorageInfo?.Disks?.[0];
            const gpu = t.GpuInfo?.Gpus?.[0];
            specs.push({
                name: t.InstanceType,
                vcpus: t.VCpuInfo?.DefaultVCpus,
                memoryMib: t.MemoryInfo?.SizeInMiB,
                network: t.NetworkInfo?.NetworkPerformance,
                networkGbps: networkToGbps(t.NetworkInfo?.NetworkPerformance),
                clockSpeedGhz: t.ProcessorInfo?.SustainedClockSpeedInGhz,
                // Filled in by the endpoint once the price list is in hand.
                hourly: undefined,
                architectures: t.ProcessorInfo?.SupportedArchitectures || [],
                currentGeneration: !!t.CurrentGeneration,
                burstable: !!t.BurstablePerformanceSupported,
                storage: t.InstanceStorageInfo?.TotalSizeInGB
                    ? `${t.InstanceStorageInfo.TotalSizeInGB} GB ${disks?.Type?.toUpperCase() || ''}`.trim()
                    : 'EBS only',
                gpu: gpu ? `${gpu.Count || 1}x ${gpu.Manufacturer || ''} ${gpu.Name || ''}`.replace(/\s+/g, ' ').trim() : undefined
            });
        }
        token = res.NextToken;
    } while (token);

    // Alphabetical alone reads badly ('c5a.12xlarge' before 'c5a.2xlarge'), so
    // group by family and order each family by actual size.
    specs.sort((a, b) => {
        const fa = a.name.split('.')[0] || a.name;
        const fb = b.name.split('.')[0] || b.name;
        if (fa !== fb) return fa.localeCompare(fb);
        if ((a.vcpus ?? 0) !== (b.vcpus ?? 0)) return (a.vcpus ?? 0) - (b.vcpus ?? 0);
        if ((a.memoryMib ?? 0) !== (b.memoryMib ?? 0)) return (a.memoryMib ?? 0) - (b.memoryMib ?? 0);
        return a.name.localeCompare(b.name);
    });
    return specs;
};

app.get('/api/instance-types', async (req, res) => {
    const arch = typeof req.query.arch === 'string' ? req.query.arch : '';
    const az = typeof req.query.az === 'string' ? req.query.az : '';
    const platform = (typeof req.query.platform === 'string' && req.query.platform) || 'Linux/UNIX';
    const key = `${arch}|${az}`;
    try {
        let pending = instanceTypeCache.get(key);
        if (!pending) {
            pending = describeInstanceTypes(arch, az);
            instanceTypeCache.set(key, pending);
            // Don't let one failed fetch poison the cache for the process's life.
            pending.catch(() => instanceTypeCache.delete(key));
        }
        const types = await pending;

        // Pricing is the one part that needs its own IAM permission, and the
        // picker is still perfectly usable without it — so a failure here costs
        // the two cost columns rather than the whole dialog.
        const region = await ec2.config.region();
        let rates: Map<string, number> | null = null;
        let pricingError: string | undefined;
        try {
            rates = await getPricing(region, platform);
        } catch (err: any) {
            console.error('Error fetching instance pricing:', err);
            pricingError = err.message;
        }

        res.json({
            types: rates
                ? types.map(t => ({ ...t, hourly: rates.get(t.name) }))
                : types,
            pricing: {
                available: !!rates,
                platform,
                os: pricingFiltersFor(platform).os,
                region,
                error: pricingError
            }
        });
    } catch (err: any) {
        console.error('Error fetching instance types:', err);
        res.status(500).json({ error: err.message });
    }
});

// Resize an instance. AWS only allows this while the instance is stopped and
// reports an attempt on a running one as a bare 'IncorrectInstanceState', so the
// state is checked up front to say what it actually is.
app.post('/api/instances/:id/type', async (req, res) => {
    const { instanceType } = req.body;
    if (!instanceType) return res.status(400).json({ error: 'No instance type provided' });
    try {
        const describe = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [req.params.id] }));
        const inst = describe.Reservations?.[0]?.Instances?.[0];
        if (!inst) return res.status(404).json({ error: 'Instance not found' });
        if (inst.InstanceType === instanceType) return res.json({ success: true, instanceType });
        if (inst.State?.Name !== 'stopped') {
            return res.status(409).json({
                error: `The instance must be stopped before its type can be changed — it is currently '${inst.State?.Name || 'unknown'}'.`
            });
        }
        await ec2.send(new ModifyInstanceAttributeCommand({
            InstanceId: req.params.id,
            InstanceType: { Value: instanceType }
        }));
        res.json({ success: true, instanceType });
    } catch (err: any) {
        console.error('Error changing instance type:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// File transfer — list, copy, and delete files in each instance's virtual
// drive staging directory. The RDP connection above mounts DRIVES_DIR/<id>
// as the "RDM Transfer" drive inside Windows, so anything the user drags
// there from Explorer appears here immediately.
// ---------------------------------------------------------------------------

app.get('/api/files/:instanceId', (req, res) => {
    const dir = path.join(DRIVES_DIR, req.params.instanceId);
    try {
        if (!fs.existsSync(dir)) return res.json([]);
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isFile())
            .map(e => {
                const stat = fs.statSync(path.join(dir, e.name));
                return { name: e.name, size: stat.size, modified: stat.mtime.toISOString() };
            });
        res.json(entries);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/transfer', (req, res) => {
    const { fromInstanceId, toInstanceId, filename } = req.body;
    if (!fromInstanceId || !toInstanceId || !filename) {
        return res.status(400).json({ error: 'fromInstanceId, toInstanceId, and filename are required' });
    }
    // Guard against path traversal.
    const safeName = path.basename(filename as string);
    if (!safeName || safeName !== filename) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const src = path.join(DRIVES_DIR, fromInstanceId, safeName);
    const destDir = path.join(DRIVES_DIR, toInstanceId);
    const dest = path.join(destDir, safeName);
    try {
        if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source file not found' });
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/files/:instanceId/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    if (!safeName || safeName !== req.params.filename) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(DRIVES_DIR, req.params.instanceId, safeName);
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Serve the built frontend. Must come after the /api/* routes above so those
// still take priority; the catch-all below is last so client-side routing
// (any non-API path) falls back to index.html.
app.use(express.static(FRONTEND_DIST));
// Express 5 (path-to-regexp v6+) requires a named wildcard — bare '*' throws
// at route registration.
app.get('/*splat', (req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));

const PORT = process.env.PORT || 3001;

initDb().then(() => {
    server.listen(PORT, () => {
        const scheme = (TLS_CERT && TLS_KEY) ? 'https' : 'http';
        console.log(`Server listening on ${scheme}://localhost:${PORT}`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
});
