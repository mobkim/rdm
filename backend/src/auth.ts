import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { generateSecret, verifyToken, keyUri } from './totp';
import QRCode from 'qrcode';
import {
    getUser, createUser, updateUserPassword,
    setPendingTotpSecret, enableTotp, disableTotp, setInactivityTimeout,
    createSession, getSession, touchSessionActivity, deleteSession
} from './db';
import { isTrustedSource } from './network';

declare global {
    namespace Express {
        interface Request {
            userId?: number;
        }
    }
}

const SESSION_COOKIE = 'rdm_session';
const SALT_ROUNDS = 12;
const SESSION_MAX_AGE_DAYS = Number(process.env.SESSION_MAX_AGE_DAYS) || 30;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

// Only set when the server itself speaks TLS — matches index.ts's own check,
// so the cookie's `secure` flag never disagrees with how the page was served.
const COOKIE_SECURE = !!(process.env.TLS_CERT && process.env.TLS_KEY);

// Logins that are mid-2FA: password already verified, waiting on a TOTP code.
// In-memory and short-lived is fine — there's one user, and losing these on a
// restart just means re-entering the password.
interface PendingLogin { userId: number; expires: number; attempts: number; }
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_TOTP_ATTEMPTS = 5;
const pendingLogins = new Map<string, PendingLogin>();

// Simple in-memory rate limiter for login attempts by IP.
// 10 attempts per 15-minute window is generous for a legitimate user but
// stops any brute-force attempt cold.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
interface RateEntry { count: number; resetAt: number; }
const loginRates = new Map<string, RateEntry>();

function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = loginRates.get(ip);
    if (!entry || entry.resetAt < now) {
        loginRates.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return false;
    }
    if (entry.count >= RATE_MAX_ATTEMPTS) return true;
    entry.count++;
    return false;
}

// Periodically prune expired rate entries so the map doesn't grow forever.
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginRates) {
        if (entry.resetAt < now) loginRates.delete(ip);
    }
}, RATE_WINDOW_MS);

function cleanupPendingLogins() {
    const now = Date.now();
    for (const [token, p] of pendingLogins) {
        if (p.expires < now) pendingLogins.delete(token);
    }
}

function cookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax' as const,
        secure: COOKIE_SECURE,
        maxAge: SESSION_MAX_AGE_MS,
        path: '/'
    };
}

async function startSession(res: Response, userId: number) {
    const token = crypto.randomBytes(32).toString('hex');
    await createSession(token, userId, new Date(Date.now() + SESSION_MAX_AGE_MS));
    res.cookie(SESSION_COOKIE, token, cookieOptions());
}

// Applied to every /api/* route except /api/auth/* (see index.ts). Confirms
// the session cookie names a live, non-expired, non-idle session.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const session = await getSession(token);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const now = Date.now();
    if (new Date(session.expires_at).getTime() < now) {
        await deleteSession(token);
        res.clearCookie(SESSION_COOKIE);
        return res.status(401).json({ error: 'Session expired' });
    }

    const user = await getUser();
    if (user && user.inactivity_timeout_minutes > 0) {
        const idleMs = now - new Date(session.last_active_at).getTime();
        if (idleMs > user.inactivity_timeout_minutes * 60000) {
            await deleteSession(token);
            res.clearCookie(SESSION_COOKIE);
            return res.status(401).json({ error: 'Session expired due to inactivity' });
        }
    }

    req.userId = session.user_id;
    next();
}

// Applied on top of requireAuth for credential-changing routes (password,
// TOTP enroll/disable) — these are locked to the trusted LAN regardless of
// whether the current session itself was established with 2FA. Rationale:
// a session reached over an untrusted network (tunnel) shouldn't be able to
// weaken or rotate the account's own credentials from out there, even if
// that session is otherwise fully authenticated.
function requireTrustedSource(req: Request, res: Response, next: NextFunction) {
    if (!isTrustedSource(req)) {
        return res.status(403).json({ error: 'This action is only available from the trusted LAN.' });
    }
    next();
}

export const authRouter = Router();

authRouter.get('/status', async (req, res) => {
    try {
        const user = await getUser();
        if (!user) return res.json({ hasUser: false, authenticated: false });

        let authenticated = false;
        const token = req.cookies?.[SESSION_COOKIE];
        if (token) {
            const session = await getSession(token);
            if (session) {
                const now = Date.now();
                const notExpired = new Date(session.expires_at).getTime() >= now;
                const notIdle = !user.inactivity_timeout_minutes ||
                    (now - new Date(session.last_active_at).getTime()) <= user.inactivity_timeout_minutes * 60000;
                authenticated = notExpired && notIdle;
                if (!authenticated) {
                    await deleteSession(token);
                    res.clearCookie(SESSION_COOKIE);
                }
            }
        }

        res.json({
            hasUser: true,
            authenticated,
            username: authenticated ? user.username : undefined,
            totpEnabled: authenticated ? !!user.totp_enabled : undefined,
            inactivityTimeoutMinutes: authenticated ? user.inactivity_timeout_minutes : undefined,
            // Drives whether Settings shows the password/2FA controls as
            // usable or locked — see requireTrustedSource, which is the
            // actual enforcement; this is just so the UI can match it.
            onLan: authenticated ? isTrustedSource(req) : undefined
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// First-run only — 403s the moment a user exists. There's no other way to
// create an account, by design (single user, no open signup).
authRouter.post('/setup', async (req, res) => {
    try {
        const existing = await getUser();
        if (existing) return res.status(403).json({ error: 'Setup has already been completed.' });

        const { username, password } = req.body || {};
        if (typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'Username is required.' });
        }
        if (typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const user = await createUser(username.trim(), hash);
        await startSession(res, user.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

authRouter.post('/login', async (req, res) => {
    try {
        const ip = req.ip ?? 'unknown';
        if (isRateLimited(ip)) {
            console.warn(`[auth] rate limit hit for login from ${ip}`);
            return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
        }

        const { username, password } = req.body || {};
        const user = await getUser();
        const invalid = () => {
            console.warn(`[auth] failed login attempt from ${ip}`);
            return res.status(401).json({ error: 'Invalid username or password.' });
        };

        if (!user || typeof username !== 'string' || typeof password !== 'string') return invalid();
        if (username !== user.username) return invalid();
        if (!(await bcrypt.compare(password, user.password_hash))) return invalid();

        // 2FA is skipped entirely from the trusted LAN, and — since it's
        // optional — skipped everywhere if the user never enabled it. It only
        // actually gates a login when both: the request isn't from a trusted
        // source, and TOTP has been turned on in Settings.
        const trusted = isTrustedSource(req);
        console.log(`[auth] login for '${username}' from ${req.ip} — trusted: ${trusted}`);
        if (!trusted && user.totp_enabled) {
            cleanupPendingLogins();
            const pendingToken = crypto.randomBytes(24).toString('hex');
            pendingLogins.set(pendingToken, { userId: user.id, expires: Date.now() + PENDING_TTL_MS, attempts: 0 });
            return res.json({ requiresTotp: true, pendingToken });
        }

        await startSession(res, user.id);
        res.json({ authenticated: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

authRouter.post('/login/totp', async (req, res) => {
    try {
        const { pendingToken, code } = req.body || {};
        const pending = typeof pendingToken === 'string' ? pendingLogins.get(pendingToken) : undefined;
        const expired = () => {
            if (typeof pendingToken === 'string') pendingLogins.delete(pendingToken);
            return res.status(401).json({ error: 'Login expired — please sign in again.' });
        };
        if (!pending || pending.expires < Date.now()) return expired();
        if (pending.attempts >= MAX_TOTP_ATTEMPTS) return expired();

        const user = await getUser();
        if (!user || user.id !== pending.userId || !user.totp_secret) return expired();

        const valid = typeof code === 'string' && verifyToken(code, user.totp_secret);
        if (!valid) {
            pending.attempts++;
            return res.status(401).json({ error: 'Invalid code.' });
        }

        pendingLogins.delete(pendingToken);
        await startSession(res, user.id);
        res.json({ authenticated: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

authRouter.post('/logout', requireAuth, async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await deleteSession(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ success: true });
});

// Called only by the frontend's activity tracker (mouse/keyboard), not on
// every API request — see App.tsx. That's what makes the inactivity timeout
// reflect real presence rather than background polling.
authRouter.post('/heartbeat', requireAuth, async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await touchSessionActivity(token);
    res.json({ success: true });
});

authRouter.post('/password', requireAuth, requireTrustedSource, async (req, res) => {
    try {
        const user = await getUser();
        if (!user) return res.status(401).json({ error: 'Not authenticated' });

        const { currentPassword, newPassword } = req.body || {};
        if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, user.password_hash))) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }
        if (typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters.' });
        }

        await updateUserPassword(user.id, await bcrypt.hash(newPassword, SALT_ROUNDS));
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

authRouter.post('/totp/setup', requireAuth, requireTrustedSource, async (req, res) => {
    try {
        const user = await getUser();
        if (!user) return res.status(401).json({ error: 'Not authenticated' });

        const secret = generateSecret();
        await setPendingTotpSecret(user.id, secret);
        const issuer = process.env.TOTP_ISSUER || 'RDm';
        const otpauth = keyUri(user.username, issuer, secret);
        const qr = await QRCode.toDataURL(otpauth);
        res.json({ secret, otpauth, qr });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

authRouter.post('/totp/verify-setup', requireAuth, requireTrustedSource, async (req, res) => {
    try {
        const user = await getUser();
        if (!user || !user.totp_secret) {
            return res.status(400).json({ error: 'No 2FA setup in progress — start over from Settings.' });
        }
        const { code } = req.body || {};
        if (typeof code !== 'string' || !verifyToken(code, user.totp_secret)) {
            return res.status(401).json({ error: 'Invalid code.' });
        }
        await enableTotp(user.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

authRouter.post('/totp/disable', requireAuth, requireTrustedSource, async (req, res) => {
    try {
        const user = await getUser();
        if (!user) return res.status(401).json({ error: 'Not authenticated' });
        const { password } = req.body || {};
        if (typeof password !== 'string' || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Password is incorrect.' });
        }
        await disableTotp(user.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

authRouter.put('/inactivity-timeout', requireAuth, async (req, res) => {
    try {
        const user = await getUser();
        if (!user) return res.status(401).json({ error: 'Not authenticated' });
        const minutes = Number((req.body || {}).minutes);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
            return res.status(400).json({ error: 'Minutes must be between 0 (disabled) and 1440.' });
        }
        await setInactivityTimeout(user.id, Math.round(minutes));
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});
