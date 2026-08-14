// Проверка крипто-конструкции Web Push (RFC 8291 + RFC 8188), зеркалит app.js
import { webcrypto as crypto, hkdfSync, createECDH, createPublicKey, verify, createDecipheriv } from 'node:crypto';
import assert from 'node:assert';

const b64u = {
  enc: b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
};
const utf8 = s => new TextEncoder().encode(s);
const concat = (...arrs) => { const o = Buffer.concat(arrs.map(a => Buffer.from(a))); return new Uint8Array(o); };
const u16 = n => new Uint8Array([n >> 8 & 255, n & 255]);

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}
async function exportRawPub(jwk) {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

// --- "клиент" (подписка браузера) ---
const clientKp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const clientPubJwk = await crypto.subtle.exportKey('jwk', clientKp.publicKey);
const clientPrivJwk = await crypto.subtle.exportKey('jwk', clientKp.privateKey);
const clientPubRaw = await exportRawPub(clientPubJwk);
const auth = crypto.getRandomValues(new Uint8Array(16));

// --- "сервер" (VAPID-ключи приложения) ---
const serverKp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const serverPubJwk = await crypto.subtle.exportKey('jwk', serverKp.publicKey);
const serverPrivJwk = await crypto.subtle.exportKey('jwk', serverKp.privateKey);
const serverPubRaw = await exportRawPub(serverPubJwk);

// --- encrypt (как в app.js) ---
async function encryptPayload(payload) {
  const serverPriv = await crypto.subtle.importKey('jwk', serverPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const clientPub = await crypto.subtle.importKey('raw', clientPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverPriv, 256));
  const ikm = await hkdf(auth, shared, utf8('Content-Encoding: auth\0'), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const context = concat(utf8('P-256\0'), u16(65), clientPubRaw, u16(serverPubRaw.length), serverPubRaw);
  const cek = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm\0'), context), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce\0'), context), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, utf8(payload)));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return { record: concat(salt, rs, Uint8Array.of(serverPubRaw.length), serverPubRaw, ct), salt, ikm, cek, nonce };
}

// --- независимый decrypt по RFC 8188 (через node:crypto примитивы) ---
function decryptRecord(record) {
  record = Buffer.from(record);
  assert.ok(record.length > 65 + 16 + 17, 'record too short');
  const salt = record.slice(0, 16);
  const rs = record.readUInt32BE(16);
  assert.equal(rs, 4096, 'rs must be 4096');
  const idlen = record[20];
  const senderPub = record.slice(21, 21 + idlen);
  const ct = record.slice(21 + idlen);
  // ECDH: общий секрет
  const client = createECDH('prime256v1');
  client.setPrivateKey(Buffer.from(clientPrivJwk.d, 'base64'));
  const shared = client.computeSecret(senderPub);
  // ikm = HKDF-Extract(auth, shared) + Expand(key_info)
  const ikm = hkdfSync('sha256', shared, Buffer.from(auth), utf8('Content-Encoding: auth\0'), 32);
  const clientPubFull = clientPubRaw; // 65 байт
  const context = Buffer.concat([Buffer.from('P-256\0'), Buffer.from([0, 65]), Buffer.from(clientPubFull), Buffer.from([0, senderPub.length]), senderPub]);
  const cek = hkdfSync('sha256', ikm, Buffer.from(salt), Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), context]), 16);
  const nonce = hkdfSync('sha256', ikm, Buffer.from(salt), Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), context]), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ct.slice(-16));
  const pt = Buffer.concat([decipher.update(ct.slice(0, -16)), decipher.final()]);
  return pt.toString('utf8');
}

// --- кросс-проверка: WebCrypto HKDF vs hkdfSync + WebCrypto ECDH vs createECDH ---
{
  const payload = JSON.stringify({ title: '⏰ Напоминание', body: 'Купить хлеб', url: './' });
  const { record, salt, ikm, cek, nonce } = await encryptPayload(payload);
  // независимый ikm
  const client = createECDH('prime256v1');
  client.setPrivateKey(Buffer.from(clientPrivJwk.d, 'base64'));
  const shared2 = client.computeSecret(serverPubRaw);
  const ikm2 = hkdfSync('sha256', shared2, Buffer.from(auth), utf8('Content-Encoding: auth\0'), 32);
  assert.deepStrictEqual(Buffer.from(ikm), Buffer.from(ikm2), 'IKM mismatch vs hkdfSync');
  console.log('✔ IKM совпадает с независимой реализацией (hkdfSync + createECDH)');
  // сравнение CEK/NONCE (RFC 8188)
  const clientPubFull = clientPubRaw;
  const context2 = Buffer.concat([Buffer.from('P-256\0'), Buffer.from([0, 65]), Buffer.from(clientPubFull), Buffer.from([0, serverPubRaw.length]), serverPubRaw]);
  const cek2 = hkdfSync('sha256', Buffer.from(ikm2), Buffer.from(salt), Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), context2]), 16);
  const nonce2 = hkdfSync('sha256', Buffer.from(ikm2), Buffer.from(salt), Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), context2]), 12);
  assert.deepStrictEqual(Buffer.from(cek), Buffer.from(cek2), 'CEK mismatch');
  assert.deepStrictEqual(Buffer.from(nonce), Buffer.from(nonce2), 'NONCE mismatch');
  console.log('✔ CEK/NONCE совпадают с независимой реализацией');
  // decrypt roundtrip
  const pt = decryptRecord(record);
  assert.equal(pt, payload, 'roundtrip failed');
  console.log('✔ Roundtrip encrypt → decrypt: payload совпадает');
  // проверка структуры
  assert.equal(record[16] * 16777216 + record[17] * 65536 + record[18] * 256 + record[19], 4096, 'rs != 4096');
  assert.equal(record[20], 65, 'keyid length != 65');
  assert.ok(record.length > 86 + 16, 'ciphertext+tag missing');
  console.log(`✔ Структура записи: salt 16б, rs 4096, keyid 65б, шифротекст+тег ${record.length - 86}б`);
}

// --- JWT ES256: проверка подписи публичным ключом ---
{
  const jwk = Object.assign({}, serverPrivJwk);
  delete jwk.key_ops; delete jwk.ext;
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64u.enc(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u.enc(utf8(JSON.stringify({ aud: 'https://fcm.googleapis.com', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'mailto:x@y.z' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, utf8(h + '.' + p)));
  // независимая проверка через node:crypto (JWK + DER)
  const derSig = (r, s) => {
    const ri = (r[0] & 0x80) ? Buffer.concat([Buffer.from([0]), r]) : r;
    const si = (s[0] & 0x80) ? Buffer.concat([Buffer.from([0]), s]) : s;
    return Buffer.concat([Buffer.from([0x30, 2 + ri.length + 2 + si.length, 0x02, ri.length]), ri, Buffer.from([0x02, si.length]), si]);
  };
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: serverPubJwk.x, y: serverPubJwk.y }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(h + '.' + p), pub, derSig(sig.slice(0, 32), sig.slice(32)));
  assert.ok(ok, 'JWT signature invalid');
  console.log('✔ JWT ES256: подпись валидна (проверено независимо, DER)');
}

function ctLen(record) { return record.length - 86; }
console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✅');
