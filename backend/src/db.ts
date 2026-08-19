import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// Key must be exactly 32 bytes for AES-256-CBC
const DB_CRYPT_KEY = Buffer.from((process.env.GUAC_CRYPT_KEY || 'MySuperSecretKeyForGuacamoleLite').padEnd(32, '0').slice(0, 32));

export let db: any = null;

export async function initDb() {
    db = await open({
        filename: path.join(__dirname, '..', 'rdm.sqlite'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS custom_instances (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ip TEXT NOT NULL,
            protocol TEXT NOT NULL DEFAULT 'rdp',
            os TEXT NOT NULL DEFAULT '',
            swap_keys INTEGER NOT NULL DEFAULT 0,
            rdp_username TEXT NOT NULL DEFAULT '',
            rdp_encrypted_password TEXT,
            vnc_username TEXT NOT NULL DEFAULT '',
            vnc_encrypted_password TEXT,
            rustdesk_encrypted_password TEXT
        );
    `);

    // CREATE TABLE IF NOT EXISTS doesn't add columns to a table that already
    // exists from before these were introduced — migrate those in place.
    const customCols = await db.all(`PRAGMA table_info(custom_instances)`);
    const hasCustomCol = (name: string) => customCols.some((c: any) => c.name === name);
    if (!hasCustomCol('protocol')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN protocol TEXT NOT NULL DEFAULT 'rdp'`);
    }
    // `os` drives the sidebar OS icon and gates the macOS-only Ctrl/Cmd swap;
    // `swap_keys` is that swap itself, only meaningful (and only editable) when
    // os = 'macos'. Reliable OS detection isn't available from guacd/VNC/RDP,
    // so both are plain user-set fields, same as protocol.
    if (!hasCustomCol('os')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN os TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCustomCol('swap_keys')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN swap_keys INTEGER NOT NULL DEFAULT 0`);
    }
    // Each protocol keeps its own credentials, so switching an instance's
    // protocol back and forth never overwrites another protocol's saved
    // username/password. RustDesk has no username concept (see rustdesk/client.ts).
    if (!hasCustomCol('rdp_username')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN rdp_username TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCustomCol('rdp_encrypted_password')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN rdp_encrypted_password TEXT`);
    }
    if (!hasCustomCol('vnc_username')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN vnc_username TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasCustomCol('vnc_encrypted_password')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN vnc_encrypted_password TEXT`);
    }
    if (!hasCustomCol('rustdesk_encrypted_password')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN rustdesk_encrypted_password TEXT`);
    }
    // Pre-migration rows had one shared username/encrypted_password column used
    // for whichever protocol was selected at the time — fold that into the
    // matching protocol-specific columns above, then drop the old ones.
    if (hasCustomCol('username') && hasCustomCol('encrypted_password')) {
        const legacyRows = await db.all(`SELECT id, username, encrypted_password, protocol FROM custom_instances`);
        for (const r of legacyRows) {
            if (r.protocol === 'rustdesk') {
                await db.run(`UPDATE custom_instances SET rustdesk_encrypted_password = ? WHERE id = ?`, [r.encrypted_password, r.id]);
            } else if (r.protocol === 'vnc') {
                await db.run(`UPDATE custom_instances SET vnc_username = ?, vnc_encrypted_password = ? WHERE id = ?`, [r.username, r.encrypted_password, r.id]);
            } else {
                await db.run(`UPDATE custom_instances SET rdp_username = ?, rdp_encrypted_password = ? WHERE id = ?`, [r.username, r.encrypted_password, r.id]);
            }
        }
        await db.exec(`ALTER TABLE custom_instances DROP COLUMN username`);
        await db.exec(`ALTER TABLE custom_instances DROP COLUMN encrypted_password`);
    }

    // Per-EC2 credential/label overrides. EC2 instances are discovered from AWS
    // (not stored), so this table only holds the bits the user can edit: a
    // display label ("custom identifier"), an RDP username, and an optional
    // password. A blank/absent password means "fall back to key.pem / env".
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ec2_settings (
            instance_id TEXT PRIMARY KEY,
            label TEXT,
            username TEXT,
            encrypted_password TEXT
        );
    `);

    const ec2Cols = await db.all(`PRAGMA table_info(ec2_settings)`);
    if (!ec2Cols.some((c: any) => c.name === 'os')) {
        await db.exec(`ALTER TABLE ec2_settings ADD COLUMN os TEXT NOT NULL DEFAULT ''`);
    }
    if (!ec2Cols.some((c: any) => c.name === 'swap_keys')) {
        await db.exec(`ALTER TABLE ec2_settings ADD COLUMN swap_keys INTEGER NOT NULL DEFAULT 0`);
    }

    // Single-user auth. `users` only ever holds one row — there's no
    // multi-account support, just a first-run setup gate.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            totp_secret TEXT,
            totp_enabled INTEGER NOT NULL DEFAULT 0,
            inactivity_timeout_minutes INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
    `);

    // Sessions are looked up by the cookie value on every request, and pruned
    // lazily (expired rows are deleted the next time they'd otherwise match).
    // `last_active_at` is only touched by the frontend's activity heartbeat —
    // NOT by every API call — so it reflects real mouse/keyboard use rather
    // than background polling.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL
        );
    `);
}

function encrypt(text: string): string {
    if (!text) return '';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', DB_CRYPT_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string {
    if (!text) return '';
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift()!, 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', DB_CRYPT_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        console.error('Decryption failed', e);
        return '';
    }
}

// ---------------------------------------------------------------------------
// Custom (non-EC2) instances
// ---------------------------------------------------------------------------

// Each protocol keeps its own username/password columns so switching an
// instance's protocol never clobbers another protocol's saved credentials.
// RustDesk has no username concept (see rustdesk/client.ts) — only a password.
function credentialColumns(protocol: string): { usernameCol: string | null; passwordCol: string } {
    switch (protocol) {
        case 'vnc':
            return { usernameCol: 'vnc_username', passwordCol: 'vnc_encrypted_password' };
        case 'rustdesk':
            return { usernameCol: null, passwordCol: 'rustdesk_encrypted_password' };
        case 'rdp':
        default:
            return { usernameCol: 'rdp_username', passwordCol: 'rdp_encrypted_password' };
    }
}

export async function addCustomInstance(id: string, name: string, ip: string, protocol: string = 'rdp', username?: string, password?: string, os: string = '', swapKeys: boolean = false) {
    const { usernameCol, passwordCol } = credentialColumns(protocol);
    const cols = ['id', 'name', 'ip', 'protocol', 'os', 'swap_keys'];
    const vals: any[] = [id, name, ip, protocol, os, swapKeys ? 1 : 0];
    if (usernameCol) {
        cols.push(usernameCol);
        vals.push(username || '');
    }
    cols.push(passwordCol);
    vals.push(password ? encrypt(password) : '');
    await db.run(
        `INSERT OR REPLACE INTO custom_instances (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        vals
    );
}

// Update an existing custom instance. Only the active protocol's username and
// (when `changePassword` is set) password columns are touched, so editing the
// identifier/IP/protocol never wipes a different protocol's saved credentials,
// and a password isn't overwritten unless the user opted into changing it. An
// empty string clears it.
export async function updateCustomInstance(
    id: string,
    fields: { name: string; ip: string; protocol: string; username?: string; os?: string; swapKeys?: boolean; changePassword?: boolean; password?: string }
) {
    const os = fields.os || '';
    const swapKeys = fields.swapKeys ? 1 : 0;
    const { usernameCol, passwordCol } = credentialColumns(fields.protocol);

    const setClauses = ['name = ?', 'ip = ?', 'protocol = ?', 'os = ?', 'swap_keys = ?'];
    const vals: any[] = [fields.name, fields.ip, fields.protocol, os, swapKeys];

    if (usernameCol) {
        setClauses.push(`${usernameCol} = ?`);
        vals.push(fields.username || '');
    }
    if (fields.changePassword) {
        setClauses.push(`${passwordCol} = ?`);
        vals.push(fields.password ? encrypt(fields.password) : '');
    }

    vals.push(id);
    await db.run(`UPDATE custom_instances SET ${setClauses.join(', ')} WHERE id = ?`, vals);
}

export async function getCustomInstances() {
    const rows = await db.all(
        'SELECT id, name, ip, protocol, os, swap_keys, rdp_username, rdp_encrypted_password, vnc_username, vnc_encrypted_password, rustdesk_encrypted_password FROM custom_instances'
    );
    // Never leak passwords to the client — expose only whether one is set,
    // per protocol, so the edit form can show the right state for whichever
    // protocol is selected.
    return rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        ip: r.ip,
        protocol: r.protocol || 'rdp',
        os: r.os || '',
        swapKeys: !!r.swap_keys,
        rdpUsername: r.rdp_username || '',
        rdpHasPassword: !!r.rdp_encrypted_password,
        vncUsername: r.vnc_username || '',
        vncHasPassword: !!r.vnc_encrypted_password,
        rustdeskHasPassword: !!r.rustdesk_encrypted_password
    }));
}

// Full record for one instance, with the active protocol's credentials
// decrypted, used when building a connection.
export async function getCustomInstance(id: string) {
    const row = await db.get('SELECT * FROM custom_instances WHERE id = ?', [id]);
    if (!row) return null;
    const protocol = row.protocol || 'rdp';
    const { usernameCol, passwordCol } = credentialColumns(protocol);
    return {
        id: row.id,
        name: row.name,
        ip: row.ip,
        protocol,
        os: row.os || '',
        swapKeys: !!row.swap_keys,
        username: usernameCol ? (row[usernameCol] || '') : '',
        password: decrypt(row[passwordCol])
    };
}

export async function deleteCustomInstance(id: string) {
    await db.run('DELETE FROM custom_instances WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// EC2 credential/label overrides
// ---------------------------------------------------------------------------

// All stored EC2 overrides, keyed by instance id, for merging into the
// discovered instance list. Passwords are never returned — only `hasPassword`.
export async function getAllEc2Settings(): Promise<Record<string, { label: string; username: string; hasPassword: boolean; os: string; swapKeys: boolean }>> {
    const rows = await db.all('SELECT instance_id, label, username, encrypted_password, os, swap_keys FROM ec2_settings');
    const map: Record<string, { label: string; username: string; hasPassword: boolean; os: string; swapKeys: boolean }> = {};
    for (const r of rows) {
        map[r.instance_id] = {
            label: r.label || '',
            username: r.username || '',
            hasPassword: !!r.encrypted_password,
            os: r.os || '',
            swapKeys: !!r.swap_keys
        };
    }
    return map;
}

// Full override (decrypted password) for one instance, used when building a
// connection. Returns null if the user has never saved settings for it.
export async function getEc2SettingFull(id: string) {
    const row = await db.get('SELECT * FROM ec2_settings WHERE instance_id = ?', [id]);
    if (!row) return null;
    return {
        label: row.label || '',
        username: row.username || '',
        password: decrypt(row.encrypted_password)
    };
}

export async function upsertEc2Setting(
    id: string,
    fields: { label?: string; username?: string; os?: string; swapKeys?: boolean; changePassword?: boolean; password?: string }
) {
    const existing = await db.get('SELECT * FROM ec2_settings WHERE instance_id = ?', [id]);
    const label = fields.label ?? existing?.label ?? '';
    const username = fields.username ?? existing?.username ?? '';
    const os = fields.os ?? existing?.os ?? '';
    const swapKeys = (fields.swapKeys ?? !!existing?.swap_keys) ? 1 : 0;
    let encPass = existing?.encrypted_password ?? '';
    if (fields.changePassword) {
        encPass = fields.password ? encrypt(fields.password) : '';
    }
    await db.run(
        'INSERT OR REPLACE INTO ec2_settings (instance_id, label, username, encrypted_password, os, swap_keys) VALUES (?, ?, ?, ?, ?, ?)',
        [id, label, username, encPass, os, swapKeys]
    );
}

// ---------------------------------------------------------------------------
// Auth — single user, plus its sessions
// ---------------------------------------------------------------------------

export interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    totp_secret: string | null;
    totp_enabled: number;
    inactivity_timeout_minutes: number;
    created_at: string;
}

// There is only ever zero or one row in `users` — this doubles as the
// first-run check (`getUser() === null` means setup hasn't happened yet).
export async function getUser(): Promise<UserRow | null> {
    const row = await db.get('SELECT * FROM users LIMIT 1');
    return row || null;
}

export async function createUser(username: string, passwordHash: string): Promise<UserRow> {
    await db.run(
        'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
        [username, passwordHash, new Date().toISOString()]
    );
    return (await getUser())!;
}

export async function updateUserPassword(id: number, passwordHash: string) {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
}

// Written on setup but not yet trusted — `totp_enabled` only flips on once
// the user proves they scanned it correctly via verifySetup.
export async function setPendingTotpSecret(id: number, secret: string) {
    await db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [secret, id]);
}

export async function enableTotp(id: number) {
    await db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [id]);
}

export async function disableTotp(id: number) {
    await db.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', [id]);
}

export async function setInactivityTimeout(id: number, minutes: number) {
    await db.run('UPDATE users SET inactivity_timeout_minutes = ? WHERE id = ?', [minutes, id]);
}

export interface SessionRow {
    id: string;
    user_id: number;
    expires_at: string;
    last_active_at: string;
}

export async function createSession(id: string, userId: number, expiresAt: Date) {
    const now = new Date().toISOString();
    await db.run(
        'INSERT INTO sessions (id, user_id, expires_at, last_active_at) VALUES (?, ?, ?, ?)',
        [id, userId, expiresAt.toISOString(), now]
    );
}

export async function getSession(id: string): Promise<SessionRow | null> {
    const row = await db.get('SELECT * FROM sessions WHERE id = ?', [id]);
    return row || null;
}

export async function touchSessionActivity(id: string) {
    await db.run('UPDATE sessions SET last_active_at = ? WHERE id = ?', [new Date().toISOString(), id]);
}

export async function deleteSession(id: string) {
    await db.run('DELETE FROM sessions WHERE id = ?', [id]);
}
