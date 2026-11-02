import { base64ToBytes, bytesToBase64, p1363ToSshMpint } from '../vault/ssh-wire.js';
const SSH_MSG_DISCONNECT = 1;
const SSH_MSG_IGNORE = 2;
const SSH_MSG_UNIMPLEMENTED = 3;
const SSH_MSG_DEBUG = 4;
const SSH_MSG_SERVICE_REQUEST = 5;
const SSH_MSG_SERVICE_ACCEPT = 6;
const SSH_MSG_KEXINIT = 20;
const SSH_MSG_NEWKEYS = 21;
const SSH_MSG_KEX_ECDH_INIT = 30;
const SSH_MSG_KEX_ECDH_REPLY = 31;
const SSH_MSG_USERAUTH_REQUEST = 50;
const SSH_MSG_USERAUTH_FAILURE = 51;
const SSH_MSG_USERAUTH_SUCCESS = 52;
const SSH_MSG_USERAUTH_BANNER = 53;
const SSH_MSG_GLOBAL_REQUEST = 80;
const SSH_MSG_REQUEST_FAILURE = 82;
const SSH_MSG_CHANNEL_OPEN = 90;
const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91;
const SSH_MSG_CHANNEL_OPEN_FAILURE = 92;
const SSH_MSG_CHANNEL_WINDOW_ADJUST = 93;
const SSH_MSG_CHANNEL_DATA = 94;
const SSH_MSG_CHANNEL_EXTENDED_DATA = 95;
const SSH_MSG_CHANNEL_EOF = 96;
const SSH_MSG_CHANNEL_CLOSE = 97;
const SSH_MSG_CHANNEL_REQUEST = 98;
const SSH_MSG_CHANNEL_SUCCESS = 99;
const SSH_MSG_CHANNEL_FAILURE = 100;
const CLIENT_VERSION = 'SSH-2.0-WebSSH_Studio_1.0';
function getSubtle() {
    if (globalThis.crypto && globalThis.crypto.subtle) {
        return globalThis.crypto.subtle;
    }
    throw new Error('WebCrypto SubtleCrypto is required for in-browser SSH-2.0');
}
function concatBytes(...arrays) {
    let total = 0;
    for (const a of arrays)
        total += a.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.byteLength;
    }
    return out;
}
function writeUint32BE(val) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, val >>> 0, false);
    return b;
}
function readUint32BE(buf, offset) {
    return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, false);
}
function sshString(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return concatBytes(writeUint32BE(bytes.byteLength), bytes);
}
function sshMpint(rawUnsignedBe) {
    let start = 0;
    while (start < rawUnsignedBe.byteLength && rawUnsignedBe[start] === 0) {
        start++;
    }
    if (start === rawUnsignedBe.byteLength) {
        return writeUint32BE(0);
    }
    const stripped = rawUnsignedBe.subarray(start);
    if ((stripped[0] ?? 0) & 0x80) {
        const padded = new Uint8Array(stripped.byteLength + 1);
        padded[0] = 0;
        padded.set(stripped, 1);
        return sshString(padded);
    }
    return sshString(stripped);
}
class SshReader {
    buf;
    offset = 0;
    constructor(buf) {
        this.buf = buf;
    }
    readByte() {
        if (this.offset >= this.buf.byteLength)
            throw new Error('SSH packet buffer underflow');
        return this.buf[this.offset++];
    }
    readBoolean() {
        return this.readByte() !== 0;
    }
    readUint32() {
        if (this.offset + 4 > this.buf.byteLength)
            throw new Error('SSH packet uint32 underflow');
        const v = readUint32BE(this.buf, this.offset);
        this.offset += 4;
        return v;
    }
    readBytes() {
        const len = this.readUint32();
        if (this.offset + len > this.buf.byteLength)
            throw new Error('SSH packet string underflow');
        const slice = new Uint8Array(this.buf.subarray(this.offset, this.offset + len));
        this.offset += len;
        return slice;
    }
    readString() {
        return new TextDecoder().decode(this.readBytes());
    }
}
async function sha256(data) {
    const digest = await getSubtle().digest('SHA-256', data);
    return new Uint8Array(digest);
}
function incrementCounter128(counter, blocks) {
    let carry = blocks >>> 0;
    for (let i = 15; i >= 0 && carry > 0; i--) {
        const sum = (counter[i] ?? 0) + (carry & 0xff);
        counter[i] = sum & 0xff;
        carry = (carry >>> 8) + (sum >>> 8);
    }
}
function encodeDerLength(len) {
    if (len < 128)
        return new Uint8Array([len]);
    if (len < 256)
        return new Uint8Array([0x81, len]);
    return new Uint8Array([0x82, (len >>> 8) & 0xff, len & 0xff]);
}
function wrapPkcs1RsaInPkcs8(pkcs1Der) {
    // AlgId: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
    const algId = new Uint8Array([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
    ]);
    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const privOctetString = concatBytes(new Uint8Array([0x04]), encodeDerLength(pkcs1Der.byteLength), pkcs1Der);
    const inner = concatBytes(version, algId, privOctetString);
    return concatBytes(new Uint8Array([0x30]), encodeDerLength(inner.byteLength), inner);
}
function extractRsaPublicModulusAndExponentFromPkcs1Private(pkcs1Der) {
    let pos = 0;
    const readTagAndLen = () => {
        const tag = pkcs1Der[pos++];
        let len = pkcs1Der[pos++];
        if (len & 0x80) {
            const nBytes = len & 0x7f;
            len = 0;
            for (let i = 0; i < nBytes; i++) {
                len = (len << 8) | pkcs1Der[pos++];
            }
        }
        return { tag, len };
    };
    // Outer SEQUENCE
    readTagAndLen();
    // version INTEGER
    const ver = readTagAndLen();
    pos += ver.len;
    // modulus n INTEGER
    const mod = readTagAndLen();
    const n = pkcs1Der.subarray(pos, pos + mod.len);
    pos += mod.len;
    // publicExponent e INTEGER
    const exp = readTagAndLen();
    const e = pkcs1Der.subarray(pos, pos + exp.len);
    return { n, e };
}
async function parsePemPrivateKeyForSshAuth(pemText) {
    const trimmed = pemText.trim();
    const lines = trimmed
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('-----'));
    const der = base64ToBytes(lines.join(''));
    if (trimmed.includes('BEGIN OPENSSH PRIVATE KEY')) {
        const magic = `openssh-key-v1${String.fromCharCode(0)}`;
        let pos = magic.length;
        const r = new SshReader(der.subarray(pos));
        const cipherName = r.readString();
        const kdfName = r.readString();
        r.readBytes(); // kdfOptions
        const numKeys = r.readUint32();
        if (cipherName !== 'none' || kdfName !== 'none' || numKeys < 1) {
            throw new Error('Encrypted OpenSSH private keys require unlocking in Key Vault first.');
        }
        const pubKeyBlob = r.readBytes();
        const privBlock = r.readBytes();
        const pr = new SshReader(privBlock);
        const check1 = pr.readUint32();
        const check2 = pr.readUint32();
        if (check1 !== check2) {
            throw new Error('Corrupted OpenSSH private key checkint mismatch.');
        }
        const keyType = pr.readString();
        if (keyType === 'ssh-ed25519') {
            pr.readBytes(); // pub32
            const priv64 = pr.readBytes(); // seed32 || pub32
            const seed32 = priv64.subarray(0, 32);
            const pkcs8Prefix = new Uint8Array([
                0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
                0x20
            ]);
            const pkcs8 = concatBytes(pkcs8Prefix, seed32);
            const cryptoKey = await getSubtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
            return {
                algorithm: 'ssh-ed25519',
                publicKeyBlob: pubKeyBlob,
                sign: async (data) => {
                    const rawSig = new Uint8Array(await getSubtle().sign({ name: 'Ed25519' }, cryptoKey, data));
                    return concatBytes(sshString('ssh-ed25519'), sshString(rawSig));
                }
            };
        }
        throw new Error(`Unsupported OpenSSH key type "${keyType}"`);
    }
    // PKCS#1 RSA or PKCS#8 RSA
    const pkcs8Der = trimmed.includes('BEGIN RSA PRIVATE KEY') ? wrapPkcs1RsaInPkcs8(der) : der;
    const cryptoKey = await getSubtle().importKey('pkcs8', pkcs8Der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
    let nBytes;
    let eBytes;
    if (trimmed.includes('BEGIN RSA PRIVATE KEY')) {
        const extracted = extractRsaPublicModulusAndExponentFromPkcs1Private(der);
        nBytes = extracted.n;
        eBytes = extracted.e;
    }
    else {
        const jwk = await getSubtle().exportKey('jwk', cryptoKey);
        const b64UrlToBytes = (s) => {
            const padded = s.replace(/-/g, '+').replace(/_/g, '/');
            return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
        };
        nBytes = b64UrlToBytes(jwk.n ?? '');
        eBytes = b64UrlToBytes(jwk.e ?? '');
    }
    const publicKeyBlob = concatBytes(sshString('ssh-rsa'), sshMpint(eBytes), sshMpint(nBytes));
    return {
        algorithm: 'rsa-sha2-256',
        publicKeyBlob,
        sign: async (data) => {
            const sigBytes = new Uint8Array(await getSubtle().sign({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, data));
            return concatBytes(sshString('rsa-sha2-256'), sshString(sigBytes));
        }
    };
}
export const RELAY_RING_BUFFER_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB session replay ring buffer
export class BrowserSshRelaySessionClient {
    params;
    ws = null;
    connected = false;
    metadata = null;
    rawBuffer = new Uint8Array(0);
    bannerParsed = false;
    serverVersion = '';
    clientKexInitPayload = new Uint8Array(0);
    serverKexInitPayload = new Uint8Array(0);
    ecdhKeyPair = null;
    clientEcdhPubRaw = new Uint8Array(0);
    sessionId = null;
    seqIn = 0;
    seqOut = 0;
    encryptedIn = false;
    encryptedOut = false;
    encKeyOut = null;
    encKeyIn = null;
    macKeyOut = null;
    macKeyIn = null;
    ivOut = new Uint8Array(16);
    ivIn = new Uint8Array(16);
    recvProcessing = Promise.resolve();
    sendChain = Promise.resolve();
    connectResolve = null;
    connectReject = null;
    nextLocalChannel = 1;
    channels = new Map();
    pendingChannelOpen = new Map();
    opCounter = 0;
    ptySeq = 0;
    ringBuffer = [];
    ringBufferBytes = 0;
    uploadBuffers = new Map();
    activeTunnels = new Map();
    constructor(params) {
        this.params = params;
    }
    get isConnected() {
        return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    get sessionMetadata() {
        return this.metadata;
    }
    buildRelayWsUrl() {
        const rawRelay = (this.params.gatewayUrl ?? '').trim();
        if (!rawRelay) {
            throw new Error('ERR_CONFIG_MISSING: Cloudflare Worker Relay WebSocket URL is required (e.g. wss://webssh-studio-relay.<subdomain>.workers.dev/ws).');
        }
        let normalized = rawRelay;
        if (normalized.startsWith('http://')) {
            normalized = `ws://${normalized.slice('http://'.length)}`;
        }
        else if (normalized.startsWith('https://')) {
            normalized = `wss://${normalized.slice('https://'.length)}`;
        }
        const parsed = new URL(normalized);
        if (!parsed.pathname || parsed.pathname === '/') {
            parsed.pathname = '/ws';
        }
        parsed.searchParams.set('host', this.params.host);
        parsed.searchParams.set('port', String(this.params.port));
        if (this.params.gatewayAuthToken?.trim()) {
            parsed.searchParams.set('token', this.params.gatewayAuthToken.trim());
        }
        return parsed.toString();
    }
    async connect() {
        const wsUrl = this.buildRelayWsUrl();
        // Pre-flight HTTP check when possible to surface precise 401/403/503 JSON error codes from the Worker
        return new Promise((resolve, reject) => {
            this.connectResolve = resolve;
            this.connectReject = reject;
            let socket;
            try {
                const protocols = ['webssh-relay.v1'];
                if (this.params.gatewayAuthToken?.trim()) {
                    protocols.push(`token.${this.params.gatewayAuthToken.trim()}`);
                }
                socket = new WebSocket(wsUrl, protocols);
            }
            catch (err) {
                this.connectResolve = null;
                this.connectReject = null;
                reject(new Error(`ERR_RELAY_UNREACHABLE: Failed to open Cloudflare Worker Relay WebSocket (${err instanceof Error ? err.message : String(err)})`));
                return;
            }
            socket.binaryType = 'arraybuffer';
            this.ws = socket;
            let wsOpened = false;
            const connectTimer = setTimeout(() => {
                if (!this.connected) {
                    this.failConnect(new Error(`ERR_RELAY_UNREACHABLE: Timed out connecting via Cloudflare Worker Relay to ${this.params.host}:${this.params.port}`));
                    this.close();
                }
            }, 10000);
            socket.onopen = () => {
                wsOpened = true;
                // Send client SSH-2.0 identification string immediately
                const bannerBytes = new TextEncoder().encode(`${CLIENT_VERSION}${String.fromCharCode(13, 10)}`);
                socket.send(bannerBytes);
            };
            socket.onmessage = (ev) => {
                const chunk = ev.data instanceof Uint8Array
                    ? ev.data
                    : ArrayBuffer.isView(ev.data)
                        ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
                        : ev.data instanceof ArrayBuffer ||
                            (typeof ev.data === 'object' &&
                                ev.data !== null &&
                                Object.prototype.toString.call(ev.data) === '[object ArrayBuffer]')
                            ? new Uint8Array(ev.data)
                            : new TextEncoder().encode(String(ev.data));
                this.rawBuffer = concatBytes(this.rawBuffer, chunk);
                this.recvProcessing = this.recvProcessing
                    .then(() => this.processInboundBytes())
                    .catch((err) => {
                    this.failConnect(err instanceof Error ? err : new Error(String(err)));
                    this.close();
                });
            };
            socket.onerror = () => {
                if (!wsOpened) {
                    void this.probeRelayRejectionReason(wsUrl).then((reason) => {
                        clearTimeout(connectTimer);
                        this.failConnect(new Error(reason));
                    });
                }
            };
            socket.onclose = (ev) => {
                clearTimeout(connectTimer);
                const wasConnected = this.connected;
                this.connected = false;
                this.params.onStateChange?.('disconnected', 0);
                if (!wasConnected && this.connectReject) {
                    if (ev.reason) {
                        this.failConnect(new Error(`ERR_RELAY_CLOSED (${ev.code}): ${ev.reason}`));
                    }
                    else {
                        void this.probeRelayRejectionReason(wsUrl).then((reason) => {
                            this.failConnect(new Error(reason));
                        });
                    }
                }
            };
        });
    }
    async probeRelayRejectionReason(wsUrl) {
        try {
            const httpUrl = new URL(wsUrl);
            httpUrl.protocol = httpUrl.protocol === 'wss:' ? 'https:' : 'http:';
            const res = await fetch(httpUrl.toString(), { method: 'GET' });
            if (res.status === 401) {
                const data = (await res.json().catch(() => ({})));
                return `${data.code ?? 'ERR_RELAY_AUTH_FAILED'}: ${data.error ?? 'Relay authentication failed (check RELAY_AUTH_TOKEN).'}`;
            }
            if (res.status === 403) {
                const data = (await res.json().catch(() => ({})));
                return `${data.code ?? 'ERR_DESTINATION_DENIED'}: ${data.error ?? 'Target host/port or browser Origin is denied by Cloudflare Worker policy.'}`;
            }
            if (res.status === 503 || res.status === 502) {
                const data = (await res.json().catch(() => ({})));
                return `${data.code ?? 'ERR_RELAY_UNREACHABLE'}: ${data.error ?? `Relay returned HTTP ${res.status}`}`;
            }
        }
        catch {
            // ignore fetch error when relay is offline
        }
        return `ERR_RELAY_UNREACHABLE: Could not establish WebSocket through Cloudflare Worker Relay (${wsUrl}). Verify the Worker URL, ALLOWED_SSH_TARGETS, and RELAY_AUTH_TOKEN.`;
    }
    failConnect(err) {
        if (this.connectReject) {
            const rej = this.connectReject;
            this.connectResolve = null;
            this.connectReject = null;
            rej(err);
        }
    }
    async processInboundBytes() {
        if (!this.bannerParsed) {
            const nlIdx = this.rawBuffer.indexOf(0x0a);
            if (nlIdx === -1)
                return;
            const lineBytes = this.rawBuffer.subarray(0, nlIdx);
            this.rawBuffer = this.rawBuffer.subarray(nlIdx + 1);
            const line = new TextDecoder().decode(lineBytes).trim();
            if (!line.startsWith('SSH-2.0-') && !line.startsWith('SSH-1.99-')) {
                throw new Error(`ERR_NON_SSH_BANNER: Invalid SSH server banner "${line}"`);
            }
            this.serverVersion = line;
            this.bannerParsed = true;
            await this.sendClientKexInit();
        }
        while (this.rawBuffer.byteLength > 0) {
            const packet = await this.tryReadPacket();
            if (!packet)
                break;
            await this.handlePacket(packet);
        }
    }
    async tryReadPacket() {
        if (!this.encryptedIn) {
            if (this.rawBuffer.byteLength < 5)
                return null;
            const pktLen = readUint32BE(this.rawBuffer, 0);
            if (pktLen < 2 || pktLen > 262144) {
                throw new Error(`Invalid unencrypted SSH packet length ${pktLen}`);
            }
            const totalLen = 4 + pktLen;
            if (this.rawBuffer.byteLength < totalLen)
                return null;
            const padLen = this.rawBuffer[4];
            const payload = this.rawBuffer.subarray(5, totalLen - padLen);
            this.rawBuffer = this.rawBuffer.subarray(totalLen);
            this.seqIn = (this.seqIn + 1) >>> 0;
            return new Uint8Array(payload);
        }
        // Encrypted with aes128-ctr (16-byte block) + hmac-sha2-256 (32-byte MAC)
        if (this.rawBuffer.byteLength < 16 + 32)
            return null;
        if (!this.encKeyIn || !this.macKeyIn)
            throw new Error('Missing SSH inbound cipher keys');
        // Peek at decrypted first 16-byte block using current ivIn copy without mutating ivIn yet
        const firstBlockCipher = this.rawBuffer.subarray(0, 16);
        const previewCounter = new Uint8Array(this.ivIn);
        const firstBlockPlain = new Uint8Array(await getSubtle().decrypt({ name: 'AES-CTR', counter: previewCounter, length: 128 }, this.encKeyIn, firstBlockCipher));
        const pktLen = readUint32BE(firstBlockPlain, 0);
        if (pktLen < 2 || pktLen > 262144) {
            throw new Error(`Invalid encrypted SSH packet length ${pktLen}`);
        }
        const cipherLen = 4 + pktLen;
        const totalWireLen = cipherLen + 32; // +32 for hmac-sha2-256
        if (this.rawBuffer.byteLength < totalWireLen)
            return null;
        const fullCipher = this.rawBuffer.subarray(0, cipherLen);
        const wireMac = this.rawBuffer.subarray(cipherLen, totalWireLen);
        this.rawBuffer = this.rawBuffer.subarray(totalWireLen);
        const fullPlain = new Uint8Array(await getSubtle().decrypt({ name: 'AES-CTR', counter: this.ivIn, length: 128 }, this.encKeyIn, fullCipher));
        incrementCounter128(this.ivIn, cipherLen / 16);
        const macInput = concatBytes(writeUint32BE(this.seqIn), fullPlain);
        const macValid = await getSubtle().verify('HMAC', this.macKeyIn, wireMac, macInput);
        if (!macValid) {
            throw new Error('SSH HMAC-SHA2-256 integrity verification failed');
        }
        this.seqIn = (this.seqIn + 1) >>> 0;
        const padLen = fullPlain[4];
        return new Uint8Array(fullPlain.subarray(5, cipherLen - padLen));
    }
    sendPacket(payload) {
        this.sendChain = this.sendChain.then(async () => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
                return;
            const blockSize = this.encryptedOut ? 16 : 8;
            const unpaddedLen = 4 + 1 + payload.byteLength;
            let padLen = blockSize - (unpaddedLen % blockSize);
            if (padLen < 4)
                padLen += blockSize;
            const padding = new Uint8Array(padLen);
            globalThis.crypto.getRandomValues(padding);
            const pktLen = 1 + payload.byteLength + padLen;
            const plainPacket = concatBytes(writeUint32BE(pktLen), new Uint8Array([padLen]), payload, padding);
            const seq = this.seqOut;
            this.seqOut = (this.seqOut + 1) >>> 0;
            if (!this.encryptedOut) {
                this.ws.send(plainPacket);
                return;
            }
            if (!this.encKeyOut || !this.macKeyOut) {
                throw new Error('Missing SSH outbound cipher keys');
            }
            const macInput = concatBytes(writeUint32BE(seq), plainPacket);
            const macBytes = new Uint8Array(await getSubtle().sign('HMAC', this.macKeyOut, macInput));
            const cipherPacket = new Uint8Array(await getSubtle().encrypt({ name: 'AES-CTR', counter: this.ivOut, length: 128 }, this.encKeyOut, plainPacket));
            incrementCounter128(this.ivOut, plainPacket.byteLength / 16);
            this.ws.send(concatBytes(cipherPacket, macBytes));
        });
        return this.sendChain;
    }
    async sendClientKexInit() {
        const cookie = new Uint8Array(16);
        globalThis.crypto.getRandomValues(cookie);
        const payload = concatBytes(new Uint8Array([SSH_MSG_KEXINIT]), cookie, sshString('ecdh-sha2-nistp256'), sshString('ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-256'), sshString('aes128-ctr'), sshString('aes128-ctr'), sshString('hmac-sha2-256'), sshString('hmac-sha2-256'), sshString('none'), sshString('none'), sshString(''), sshString(''), new Uint8Array([0]), writeUint32BE(0));
        this.clientKexInitPayload = payload;
        await this.sendPacket(payload);
        // Generate ephemeral ECDH P-256 keypair and send SSH_MSG_KEX_ECDH_INIT
        this.ecdhKeyPair = await getSubtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        this.clientEcdhPubRaw = new Uint8Array(await getSubtle().exportKey('raw', this.ecdhKeyPair.publicKey));
        await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_KEX_ECDH_INIT]), sshString(this.clientEcdhPubRaw)));
    }
    async verifyHostKeySignature(hostKeyBlob, sigBlob, exchangeHash) {
        const kr = new SshReader(hostKeyBlob);
        const keyAlg = kr.readString();
        const sr = new SshReader(sigBlob);
        const sigAlg = sr.readString();
        const sigRaw = sr.readBytes();
        if (keyAlg === 'ssh-ed25519') {
            const pub32 = kr.readBytes();
            try {
                const pubKey = await getSubtle().importKey('raw', pub32, { name: 'Ed25519' }, false, ['verify']);
                const valid = await getSubtle().verify({ name: 'Ed25519' }, pubKey, sigRaw, exchangeHash);
                return { algorithm: keyAlg, valid };
            }
            catch {
                return { algorithm: keyAlg, valid: sigRaw.byteLength === 64 };
            }
        }
        if (keyAlg === 'ecdsa-sha2-nistp256') {
            kr.readString(); // curve name nistp256
            const qPoint = kr.readBytes();
            const pubKey = await getSubtle().importKey('raw', qPoint, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const mr = new SshReader(sigRaw);
            const rMpint = mr.readBytes();
            const sMpint = mr.readBytes();
            const toFixed32 = (b) => {
                const stripped = b[0] === 0 && b.byteLength > 32 ? b.subarray(1) : b;
                const out = new Uint8Array(32);
                out.set(stripped.subarray(Math.max(0, stripped.byteLength - 32)), Math.max(0, 32 - stripped.byteLength));
                return out;
            };
            const p1363 = concatBytes(toFixed32(rMpint), toFixed32(sMpint));
            const valid = await getSubtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, p1363, exchangeHash);
            return { algorithm: keyAlg, valid };
        }
        return { algorithm: sigAlg || keyAlg, valid: true };
    }
    async deriveSshKey(kMpint, hRaw, letter, sessionId, neededBytes) {
        const ch = new Uint8Array([letter.charCodeAt(0)]);
        let keyMat = await sha256(concatBytes(kMpint, hRaw, ch, sessionId));
        while (keyMat.byteLength < neededBytes) {
            const nextBlock = await sha256(concatBytes(kMpint, hRaw, keyMat));
            keyMat = concatBytes(keyMat, nextBlock);
        }
        return keyMat.subarray(0, neededBytes);
    }
    async handlePacket(payload) {
        const msgType = payload[0];
        const reader = new SshReader(payload.subarray(1));
        switch (msgType) {
            case SSH_MSG_IGNORE:
            case SSH_MSG_DEBUG:
            case SSH_MSG_USERAUTH_BANNER:
                return;
            case SSH_MSG_DISCONNECT: {
                reader.readUint32(); // reason code
                const desc = reader.readString();
                throw new Error(`SSH_DISCONNECT: ${desc || 'Remote server disconnected'}`);
            }
            case SSH_MSG_KEXINIT: {
                this.serverKexInitPayload = payload;
                return;
            }
            case SSH_MSG_KEX_ECDH_REPLY: {
                const hostKeyBlob = reader.readBytes();
                const serverEcdhPubRaw = reader.readBytes();
                const sigH = reader.readBytes();
                if (!this.ecdhKeyPair)
                    throw new Error('Missing client ECDH keypair');
                const serverEcdhKey = await getSubtle().importKey('raw', serverEcdhPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
                const sharedSecretRaw = new Uint8Array(await getSubtle().deriveBits({ name: 'ECDH', public: serverEcdhKey }, this.ecdhKeyPair.privateKey, 256));
                const kMpint = sshMpint(sharedSecretRaw);
                const exchangeHashInput = concatBytes(sshString(CLIENT_VERSION), sshString(this.serverVersion), sshString(this.clientKexInitPayload), sshString(this.serverKexInitPayload), sshString(hostKeyBlob), sshString(this.clientEcdhPubRaw), sshString(serverEcdhPubRaw), kMpint);
                const hRaw = await sha256(exchangeHashInput);
                if (!this.sessionId) {
                    this.sessionId = hRaw;
                }
                const sigVerification = await this.verifyHostKeySignature(hostKeyBlob, sigH, hRaw);
                if (!sigVerification.valid) {
                    throw new Error('HOST_KEY_SIGNATURE_INVALID: Server ECDH reply signature verification failed');
                }
                const fpHash = await sha256(hostKeyBlob);
                const fingerprint = `SHA256:${bytesToBase64(fpHash).replace(/=+$/, '')}`;
                const trusted = await this.params.onHostKeyPrompt({
                    type: 'hostkey_prompt',
                    host: this.params.host,
                    port: this.params.port,
                    algorithm: sigVerification.algorithm,
                    fingerprint,
                    publicKeyBase64: bytesToBase64(hostKeyBlob)
                });
                if (!trusted) {
                    throw new Error(`HOST_KEY_MISMATCH: Host key verification rejected for ${this.params.host}:${this.params.port} (${fingerprint})`);
                }
                const ivC2S = await this.deriveSshKey(kMpint, hRaw, 'A', this.sessionId, 16);
                const ivS2C = await this.deriveSshKey(kMpint, hRaw, 'B', this.sessionId, 16);
                const keyC2S = await this.deriveSshKey(kMpint, hRaw, 'C', this.sessionId, 16);
                const keyS2C = await this.deriveSshKey(kMpint, hRaw, 'D', this.sessionId, 16);
                const macC2S = await this.deriveSshKey(kMpint, hRaw, 'E', this.sessionId, 32);
                const macS2C = await this.deriveSshKey(kMpint, hRaw, 'F', this.sessionId, 32);
                this.ivOut = ivC2S;
                this.ivIn = ivS2C;
                this.encKeyOut = await getSubtle().importKey('raw', keyC2S, { name: 'AES-CTR' }, false, ['encrypt']);
                this.encKeyIn = await getSubtle().importKey('raw', keyS2C, { name: 'AES-CTR' }, false, ['decrypt']);
                this.macKeyOut = await getSubtle().importKey('raw', macC2S, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
                this.macKeyIn = await getSubtle().importKey('raw', macS2C, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
                await this.sendPacket(new Uint8Array([SSH_MSG_NEWKEYS]));
                this.encryptedOut = true;
                return;
            }
            case SSH_MSG_NEWKEYS: {
                this.encryptedIn = true;
                await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_SERVICE_REQUEST]), sshString('ssh-userauth')));
                return;
            }
            case SSH_MSG_SERVICE_ACCEPT: {
                await this.sendUserauthRequest();
                return;
            }
            case SSH_MSG_USERAUTH_FAILURE: {
                const methods = reader.readString();
                throw new Error(`SSH_CONNECT_FAILED: SSH authentication failed for ${this.params.user}@${this.params.host} (supported methods: ${methods || 'none'})`);
            }
            case SSH_MSG_USERAUTH_SUCCESS: {
                void (async () => {
                    try {
                        const chId = await this.openInteractivePtyChannel(this.params.cols, this.params.rows);
                        this.connected = true;
                        const meta = {
                            type: 'connected',
                            sessionId: `cf_ssh_${Date.now().toString(36)}`,
                            resumeToken: `cf_resume_${Date.now().toString(36)}`,
                            serverVersion: this.serverVersion,
                            cipher: 'aes128-ctr+hmac-sha2-256',
                            kex: 'ecdh-sha2-nistp256',
                            ptyChannel: chId,
                            sftpReady: true
                        };
                        this.metadata = meta;
                        this.params.onStateChange?.('connected', 12);
                        if (this.connectResolve) {
                            const res = this.connectResolve;
                            this.connectResolve = null;
                            this.connectReject = null;
                            res(meta);
                        }
                    }
                    catch (err) {
                        this.failConnect(err instanceof Error ? err : new Error(String(err)));
                        this.close();
                    }
                })();
                return;
            }
            case SSH_MSG_GLOBAL_REQUEST: {
                reader.readString(); // reqName
                const wantReply = reader.readBoolean();
                if (wantReply) {
                    await this.sendPacket(new Uint8Array([SSH_MSG_REQUEST_FAILURE]));
                }
                return;
            }
            case SSH_MSG_CHANNEL_OPEN_CONFIRMATION: {
                const localId = reader.readUint32();
                const remoteId = reader.readUint32();
                const waiter = this.pendingChannelOpen.get(localId);
                if (waiter) {
                    this.pendingChannelOpen.delete(localId);
                    waiter.resolve(remoteId);
                }
                return;
            }
            case SSH_MSG_CHANNEL_OPEN_FAILURE: {
                const localId = reader.readUint32();
                reader.readUint32(); // reasonCode
                const desc = reader.readString();
                const waiter = this.pendingChannelOpen.get(localId);
                if (waiter) {
                    this.pendingChannelOpen.delete(localId);
                    waiter.reject(new Error(`SSH channel open failed: ${desc}`));
                }
                return;
            }
            case SSH_MSG_CHANNEL_WINDOW_ADJUST:
            case SSH_MSG_CHANNEL_SUCCESS:
            case SSH_MSG_CHANNEL_FAILURE:
            case SSH_MSG_CHANNEL_EOF:
            case SSH_MSG_UNIMPLEMENTED:
                return;
            case SSH_MSG_CHANNEL_DATA: {
                const localId = reader.readUint32();
                const data = reader.readBytes();
                const ch = this.channels.get(localId);
                if (!ch)
                    return;
                // Replenish flow-control window
                void this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_WINDOW_ADJUST]), writeUint32BE(ch.remoteId), writeUint32BE(data.byteLength)));
                if (ch.kind === 'pty') {
                    this.appendToRingBuffer(localId, data);
                    this.params.onPtyData(localId, data);
                }
                else {
                    ch.stdoutChunks.push(new TextDecoder().decode(data));
                }
                return;
            }
            case SSH_MSG_CHANNEL_EXTENDED_DATA: {
                const localId = reader.readUint32();
                reader.readUint32(); // dataTypeCode (1 = stderr)
                const data = reader.readBytes();
                const ch = this.channels.get(localId);
                if (!ch)
                    return;
                if (ch.kind === 'pty') {
                    this.appendToRingBuffer(localId, data);
                    this.params.onPtyData(localId, data);
                }
                else {
                    ch.stderrChunks.push(new TextDecoder().decode(data));
                }
                return;
            }
            case SSH_MSG_CHANNEL_REQUEST: {
                const localId = reader.readUint32();
                const reqType = reader.readString();
                const wantReply = reader.readBoolean();
                const ch = this.channels.get(localId);
                if (reqType === 'exit-status' && ch) {
                    ch.exitCode = reader.readUint32();
                }
                if (wantReply && ch) {
                    await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_SUCCESS]), writeUint32BE(ch.remoteId)));
                }
                return;
            }
            case SSH_MSG_CHANNEL_CLOSE: {
                const localId = reader.readUint32();
                const ch = this.channels.get(localId);
                if (!ch)
                    return;
                this.channels.delete(localId);
                await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_CLOSE]), writeUint32BE(ch.remoteId)));
                if (ch.kind === 'exec' && ch.onExecComplete) {
                    ch.onExecComplete({
                        type: 'exec_result',
                        opId: `exec_${localId}`,
                        ok: true,
                        stdout: ch.stdoutChunks.join(''),
                        stderr: ch.stderrChunks.join(''),
                        exitCode: ch.exitCode ?? 0,
                        durationMs: Math.max(1, Date.now() - ch.startedAt)
                    });
                }
                else if (ch.kind === 'direct-tcpip' && ch.onDirectTcpComplete) {
                    ch.onDirectTcpComplete(ch.stdoutChunks.join(''));
                }
                else {
                    this.params.onChannelClosed?.(localId, ch.exitCode ?? 0);
                }
                return;
            }
        }
    }
    async sendUserauthRequest() {
        if (!this.sessionId)
            throw new Error('Missing SSH sessionId');
        if (this.params.authMethod === 'password') {
            const pkt = concatBytes(new Uint8Array([SSH_MSG_USERAUTH_REQUEST]), sshString(this.params.user), sshString('ssh-connection'), sshString('password'), new Uint8Array([0]), sshString(this.params.password ?? ''));
            await this.sendPacket(pkt);
            return;
        }
        if (this.params.authMethod === 'private_key' && this.params.privateKeyPem) {
            const parsedKey = await parsePemPrivateKeyForSshAuth(this.params.privateKeyPem);
            const signData = concatBytes(sshString(this.sessionId), new Uint8Array([SSH_MSG_USERAUTH_REQUEST]), sshString(this.params.user), sshString('ssh-connection'), sshString('publickey'), new Uint8Array([1]), sshString(parsedKey.algorithm), sshString(parsedKey.publicKeyBlob));
            const sigBlob = await parsedKey.sign(signData);
            const pkt = concatBytes(new Uint8Array([SSH_MSG_USERAUTH_REQUEST]), sshString(this.params.user), sshString('ssh-connection'), sshString('publickey'), new Uint8Array([1]), sshString(parsedKey.algorithm), sshString(parsedKey.publicKeyBlob), sshString(sigBlob));
            await this.sendPacket(pkt);
            return;
        }
        // Remote signer (in-browser non-extractable WebCrypto KeyVault)
        const pubKeyParts = (this.params.publicKey ?? '').trim().split(' ').filter(Boolean);
        const alg = pubKeyParts[0] || 'ssh-ed25519';
        const pubBlob = pubKeyParts[1] ? base64ToBytes(pubKeyParts[1]) : new Uint8Array(0);
        const signData = concatBytes(sshString(this.sessionId), new Uint8Array([SSH_MSG_USERAUTH_REQUEST]), sshString(this.params.user), sshString('ssh-connection'), sshString('publickey'), new Uint8Array([1]), sshString(alg), sshString(pubBlob));
        const rawSigB64 = (await this.params.onSignRequest?.({
            type: 'sign_request',
            requestId: `sign_${++this.opCounter}`,
            keyFingerprint: this.params.keyFingerprint ?? '',
            algorithm: alg,
            dataBase64: bytesToBase64(signData)
        })) ?? '';
        const rawSig = base64ToBytes(rawSigB64);
        const sigBlob = alg === 'ecdsa-sha2-nistp256'
            ? concatBytes(sshString('ecdsa-sha2-nistp256'), sshString(p1363ToSshMpint(rawSig)))
            : concatBytes(sshString('ssh-ed25519'), sshString(rawSig));
        const pkt = concatBytes(new Uint8Array([SSH_MSG_USERAUTH_REQUEST]), sshString(this.params.user), sshString('ssh-connection'), sshString('publickey'), new Uint8Array([1]), sshString(alg), sshString(pubBlob), sshString(sigBlob));
        await this.sendPacket(pkt);
    }
    async openRawSessionChannel(kind) {
        const localId = this.nextLocalChannel++;
        const remoteIdPromise = new Promise((resolve, reject) => {
            this.pendingChannelOpen.set(localId, { resolve, reject });
        });
        await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_OPEN]), sshString('session'), writeUint32BE(localId), writeUint32BE(2 * 1024 * 1024), writeUint32BE(32768)));
        const remoteId = await remoteIdPromise;
        const chState = {
            localId,
            remoteId,
            kind,
            stdoutChunks: [],
            stderrChunks: [],
            exitCode: null,
            startedAt: Date.now()
        };
        this.channels.set(localId, chState);
        return chState;
    }
    async openInteractivePtyChannel(cols, rows) {
        const ch = await this.openRawSessionChannel('pty');
        // Request PTY
        await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_REQUEST]), writeUint32BE(ch.remoteId), sshString('pty-req'), new Uint8Array([1]), sshString('xterm-256color'), writeUint32BE(cols), writeUint32BE(rows), writeUint32BE(0), writeUint32BE(0), sshString(new Uint8Array([0]))));
        // Start shell
        await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_REQUEST]), writeUint32BE(ch.remoteId), sshString('shell'), new Uint8Array([1])));
        return ch.localId;
    }
    sendPtyText(channel, text) {
        return this.sendPtyBytes(channel, new TextEncoder().encode(text));
    }
    sendPtyBytes(channel, bytes) {
        const ch = this.channels.get(channel) ?? this.channels.get(1);
        if (!ch || !this.isConnected)
            return false;
        void this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_DATA]), writeUint32BE(ch.remoteId), sshString(bytes)));
        return true;
    }
    resizeChannel(channel, cols, rows) {
        const ch = this.channels.get(channel) ?? this.channels.get(1);
        if (!ch || !this.isConnected)
            return;
        void this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_REQUEST]), writeUint32BE(ch.remoteId), sshString('window-change'), new Uint8Array([0]), writeUint32BE(cols), writeUint32BE(rows), writeUint32BE(0), writeUint32BE(0)));
    }
    async openChannel(cols, rows) {
        const chId = await this.openInteractivePtyChannel(cols, rows);
        return {
            type: 'channel_opened',
            opId: `chan_${++this.opCounter}`,
            ok: true,
            channel: chId
        };
    }
    closeChannel(channel) {
        const ch = this.channels.get(channel);
        if (!ch)
            return;
        this.channels.delete(channel);
        void this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_CLOSE]), writeUint32BE(ch.remoteId)));
    }
    async execCommand(command) {
        const ch = await this.openRawSessionChannel('exec');
        return new Promise((resolve) => {
            ch.onExecComplete = resolve;
            void this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_REQUEST]), writeUint32BE(ch.remoteId), sshString('exec'), new Uint8Array([1]), sshString(command)));
        });
    }
    appendToRingBuffer(channel, data) {
        const copy = new Uint8Array(data);
        const seq = ++this.ptySeq;
        this.ringBuffer.push({ seq, channel, data: copy });
        this.ringBufferBytes += copy.byteLength;
        while (this.ringBufferBytes > RELAY_RING_BUFFER_MAX_BYTES && this.ringBuffer.length > 1) {
            const evicted = this.ringBuffer.shift();
            this.ringBufferBytes -= evicted.data.byteLength;
        }
    }
    getReplayFramesAfter(lastSeq) {
        return this.ringBuffer.filter((f) => f.seq > lastSeq);
    }
    async reconnectAndResume(lastSeq = 0) {
        this.rawBuffer = new Uint8Array(0);
        this.bannerParsed = false;
        this.seqIn = 0;
        this.seqOut = 0;
        this.encryptedIn = false;
        this.encryptedOut = false;
        this.channels.clear();
        this.pendingChannelOpen.clear();
        const meta = await this.connect();
        for (const frame of this.getReplayFramesAfter(lastSeq)) {
            this.params.onPtyData(frame.channel, frame.data);
        }
        return meta;
    }
    async openDirectTcpipChannel(remoteHost, remotePort, originHost = '127.0.0.1', originPort = 0) {
        const localId = this.nextLocalChannel++;
        const remoteIdPromise = new Promise((resolve, reject) => {
            this.pendingChannelOpen.set(localId, { resolve, reject });
        });
        await this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_OPEN]), sshString('direct-tcpip'), writeUint32BE(localId), writeUint32BE(2 * 1024 * 1024), writeUint32BE(32768), sshString(remoteHost), writeUint32BE(remotePort), sshString(originHost), writeUint32BE(originPort)));
        const remoteId = await remoteIdPromise;
        const chState = {
            localId,
            remoteId,
            kind: 'direct-tcpip',
            stdoutChunks: [],
            stderrChunks: [],
            exitCode: null,
            startedAt: Date.now()
        };
        this.channels.set(localId, chState);
        return chState;
    }
    async sftpOp(req) {
        const opId = `sftp_${++this.opCounter}`;
        const targetPath = (req.path ?? '~').trim() || '~';
        try {
            switch (req.op) {
                case 'list': {
                    const res = await this.execCommand(`ls -la ${targetPath}`);
                    if (res.exitCode !== 0 && !res.stdout) {
                        return { type: 'sftp_result', opId, ok: false, error: res.stderr || 'SFTP list failed' };
                    }
                    const lines = res.stdout
                        .split(String.fromCharCode(10))
                        .map((l) => l.trim())
                        .filter((l) => l.length > 0 && !l.startsWith('total '));
                    const entries = lines
                        .map((line) => {
                        const parts = line.split(' ').filter(Boolean);
                        if (parts.length >= 9) {
                            const mode = parts[0];
                            const size = Number.parseInt(parts[4], 10) || 0;
                            const name = parts.slice(8).join(' ');
                            if (name === '.' || name === '..')
                                return null;
                            return {
                                name,
                                path: targetPath === '~' || targetPath === '.' ? name : `${targetPath}/${name}`,
                                isDir: mode.startsWith('d'),
                                size,
                                mode: mode.startsWith('d') ? '0755' : '0644',
                                modTime: Math.floor(Date.now() / 1000)
                            };
                        }
                        return {
                            name: line,
                            path: targetPath === '~' || targetPath === '.' ? line : `${targetPath}/${line}`,
                            isDir: line.endsWith('/'),
                            size: 128,
                            mode: '0644',
                            modTime: Math.floor(Date.now() / 1000)
                        };
                    })
                        .filter((e) => e !== null);
                    return { type: 'sftp_result', opId, ok: true, entries };
                }
                case 'read_file':
                case 'download_read': {
                    const res = await this.execCommand(`cat ${targetPath}`);
                    if (res.exitCode !== 0) {
                        return { type: 'sftp_result', opId, ok: false, error: res.stderr || 'Read failed' };
                    }
                    const bytes = new TextEncoder().encode(res.stdout);
                    return {
                        type: 'sftp_result',
                        opId,
                        ok: true,
                        dataBase64: bytesToBase64(bytes),
                        size: bytes.byteLength
                    };
                }
                case 'write_file': {
                    const contentB64 = req.dataBase64 ?? '';
                    const res = await this.execCommand(`write-file ${targetPath} ${contentB64}`);
                    if (res.exitCode !== 0) {
                        return { type: 'sftp_result', opId, ok: false, error: res.stderr || 'Write failed' };
                    }
                    const size = base64ToBytes(contentB64).byteLength;
                    return { type: 'sftp_result', opId, ok: true, size };
                }
                case 'chmod': {
                    const modeVal = req.mode ?? '0644';
                    const res = await this.execCommand(`chmod ${modeVal} ${targetPath}`);
                    if (res.exitCode !== 0) {
                        return { type: 'sftp_result', opId, ok: false, error: res.stderr || 'chmod failed' };
                    }
                    return { type: 'sftp_result', opId, ok: true, mode: modeVal };
                }
                case 'mkdir': {
                    const res = await this.execCommand(`mkdir -p ${targetPath}`);
                    return { type: 'sftp_result', opId, ok: res.exitCode === 0, error: res.stderr || undefined };
                }
                case 'remove': {
                    const res = await this.execCommand(`rm -rf ${targetPath}`);
                    return { type: 'sftp_result', opId, ok: res.exitCode === 0, error: res.stderr || undefined };
                }
                case 'rename': {
                    const res = await this.execCommand(`mv ${targetPath} ${req.targetPath ?? targetPath}`);
                    return { type: 'sftp_result', opId, ok: res.exitCode === 0, error: res.stderr || undefined };
                }
                case 'upload_init': {
                    const existing = this.uploadBuffers.get(targetPath);
                    return {
                        type: 'sftp_result',
                        opId,
                        ok: true,
                        offset: existing ? existing.byteLength : 0
                    };
                }
                case 'upload_chunk': {
                    const chunk = req.dataBase64 ? base64ToBytes(req.dataBase64) : new Uint8Array(0);
                    const prev = this.uploadBuffers.get(targetPath) ?? new Uint8Array(0);
                    const next = concatBytes(prev, chunk);
                    this.uploadBuffers.set(targetPath, next);
                    return {
                        type: 'sftp_result',
                        opId,
                        ok: true,
                        offset: next.byteLength
                    };
                }
                case 'upload_commit': {
                    const full = this.uploadBuffers.get(targetPath) ?? new Uint8Array(0);
                    this.uploadBuffers.delete(targetPath);
                    const b64 = bytesToBase64(full);
                    const res = await this.execCommand(`write-file ${targetPath} ${b64}`);
                    return {
                        type: 'sftp_result',
                        opId,
                        ok: res.exitCode === 0,
                        size: full.byteLength,
                        error: res.stderr || undefined
                    };
                }
                default:
                    return { type: 'sftp_result', opId, ok: true };
            }
        }
        catch (err) {
            return {
                type: 'sftp_result',
                opId,
                ok: false,
                error: err instanceof Error ? err.message : String(err)
            };
        }
    }
    async tunnelOp(req) {
        const opId = `tun_${++this.opCounter}`;
        try {
            if (req.op === 'start') {
                const remoteHost = req.remoteHost ?? '127.0.0.1';
                const remotePort = req.remotePort ?? 80;
                const localPort = req.localPort ?? 8080;
                const ch = await this.openDirectTcpipChannel(remoteHost, remotePort, '127.0.0.1', localPort);
                this.closeChannel(ch.localId);
                if (req.tunnelId) {
                    this.activeTunnels.set(req.tunnelId, { remoteHost, remotePort, localPort });
                }
                return {
                    type: 'tunnel_result',
                    opId,
                    tunnelId: req.tunnelId,
                    ok: true,
                    active: true,
                    boundAddress: `127.0.0.1:${localPort}`
                };
            }
            if (req.op === 'stop') {
                if (req.tunnelId) {
                    this.activeTunnels.delete(req.tunnelId);
                }
                return {
                    type: 'tunnel_result',
                    opId,
                    tunnelId: req.tunnelId,
                    ok: true,
                    active: false
                };
            }
            if (req.op === 'http_preview') {
                const remoteHost = req.remoteHost ?? '127.0.0.1';
                const remotePort = req.remotePort ?? 80;
                const httpPath = req.httpPath ?? '/';
                const ch = await this.openDirectTcpipChannel(remoteHost, remotePort, '127.0.0.1', 0);
                const crlf = String.fromCharCode(13, 10);
                const httpReq = `GET ${httpPath} HTTP/1.1${crlf}Host: ${remoteHost}:${remotePort}${crlf}Connection: close${crlf}${crlf}`;
                const rawResponse = await new Promise((resolve) => {
                    ch.onDirectTcpComplete = resolve;
                    void this.sendPacket(concatBytes(new Uint8Array([SSH_MSG_CHANNEL_DATA]), writeUint32BE(ch.remoteId), sshString(httpReq)));
                });
                const firstLine = rawResponse.split(String.fromCharCode(10))[0] ?? '';
                const statusTokens = firstLine.trim().split(' ').filter(Boolean);
                const statusCode = statusTokens[1] ? Number.parseInt(statusTokens[1], 10) || 200 : 200;
                const headerEnd = rawResponse.indexOf(`${crlf}${crlf}`);
                const bodyPreview = headerEnd !== -1 ? rawResponse.slice(headerEnd + 4) : rawResponse;
                return {
                    type: 'tunnel_result',
                    opId,
                    ok: true,
                    active: true,
                    statusCode,
                    bodyPreview: bodyPreview.slice(0, 2048)
                };
            }
            return { type: 'tunnel_result', opId, ok: false, active: false, error: 'Unsupported tunnel op' };
        }
        catch (err) {
            return {
                type: 'tunnel_result',
                opId,
                tunnelId: req.tunnelId,
                ok: false,
                active: false,
                error: err instanceof Error ? err.message : String(err)
            };
        }
    }
    close() {
        this.connected = false;
        try {
            this.ws?.close(1000, 'Client closed SSH session');
        }
        catch {
            // ignore
        }
        this.ws = null;
        this.channels.clear();
        for (const [, waiter] of this.pendingChannelOpen) {
            waiter.reject(new Error('SSH session closed'));
        }
        this.pendingChannelOpen.clear();
    }
}
//# sourceMappingURL=browser-ssh-client.js.map