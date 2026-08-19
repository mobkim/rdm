import crypto from 'crypto';

// Minimal RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step) — the parameters every
// authenticator app (Google Authenticator, Authy, ...) assumes by default, so
// there's no negotiation needed. Hand-rolled rather than a dependency: it's
// ~60 lines of well-specified crypto, and matches the existing AES helpers in
// db.ts rather than pulling in a third-party TOTP library.

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // tolerate the code 1 step (30s) before/after, for clock drift

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

function base32Decode(input: string): Buffer {
    const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of clean) {
        const idx = BASE32_ALPHABET.indexOf(char);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest();
    const offset = hmac[hmac.length - 1]! & 0xf;
    const binary =
        ((hmac[offset]! & 0x7f) << 24) |
        ((hmac[offset + 1]! & 0xff) << 16) |
        ((hmac[offset + 2]! & 0xff) << 8) |
        (hmac[offset + 3]! & 0xff);
    const otp = binary % 10 ** DIGITS;
    return otp.toString().padStart(DIGITS, '0');
}

// Track recently consumed TOTP codes to prevent replay within the same window.
// Keyed by "counter:token"; entries expire after the window they were valid for passes.
const usedTokens = new Map<string, number>(); // key -> expiry timestamp

setInterval(() => {
    const now = Date.now();
    for (const [key, expiry] of usedTokens) {
        if (expiry < now) usedTokens.delete(key);
    }
}, 60 * 1000);

// 160 bits (20 bytes) — the RFC-recommended key size for HMAC-SHA1.
export function generateSecret(): string {
    return base32Encode(crypto.randomBytes(20));
}

export function verifyToken(token: string, base32Secret: string): boolean {
    if (!/^\d{6}$/.test(token)) return false;
    const secret = base32Decode(base32Secret);
    const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
    const tokenBuf = Buffer.from(token);
    for (let offset = -WINDOW; offset <= WINDOW; offset++) {
        const candidate = Buffer.from(hotp(secret, counter + offset));
        if (crypto.timingSafeEqual(candidate, tokenBuf)) {
            const key = `${counter + offset}:${token}`;
            if (usedTokens.has(key)) return false; // replay detected
            // Expire after this counter step plus one window of drift
            usedTokens.set(key, (counter + offset + WINDOW + 1) * STEP_SECONDS * 1000);
            return true;
        }
    }
    return false;
}

export function keyUri(accountName: string, issuer: string, base32Secret: string): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
    const params = new URLSearchParams({
        secret: base32Secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS)
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}
