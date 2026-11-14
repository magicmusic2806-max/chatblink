// WebAuthn verification for the passkey door, with no dependency.
//
// The browser hands back a clientDataJSON, an authenticatorData blob and (at registration) a CBOR
// attestation object; the credential's public key inside that CBOR is a COSE_Key. Only ES256/P-256 is
// accepted, which is what every platform authenticator produces (Touch ID, Windows Hello, Android
// fingerprint/face). RSA keys are rejected with a clear message rather than silently failing later.
//
// The key is converted to SPKI once, at registration, so a login is one importKey plus one verify.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(text + "=".repeat((4 - (text.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
export const rpIdHashFor = rpId => sha256(encoder.encode(rpId));

// Definite-length CBOR only, which is all an attestation object or a COSE key ever uses.
function cbor(bytes, offset = 0) {
  if (offset >= bytes.length) throw new Error("That passkey response was truncated.");
  const initial = bytes[offset], major = initial >> 5, info = initial & 31;
  let length = info, cursor = offset + 1;
  if (info >= 24 && info <= 27) {
    const size = 1 << (info - 24);
    length = 0;
    for (let index = 0; index < size; index++) length = length * 256 + bytes[cursor + index];
    cursor += size;
  }
  if (major === 0) return [length, cursor];
  if (major === 1) return [-1 - length, cursor];
  if (major === 2) return [bytes.slice(cursor, cursor + length), cursor + length];
  if (major === 3) return [decoder.decode(bytes.slice(cursor, cursor + length)), cursor + length];
  if (major === 4) {
    const items = [];
    for (let index = 0; index < length; index++) { const [value, next] = cbor(bytes, cursor); items.push(value); cursor = next; }
    return [items, cursor];
  }
  if (major === 5) {
    const map = {};
    for (let index = 0; index < length; index++) {
      const [key, afterKey] = cbor(bytes, cursor), [value, afterValue] = cbor(bytes, afterKey);
      map[key] = value;
      cursor = afterValue;
    }
    return [map, cursor];
  }
  // Tags and floats carry nothing this code needs; skip the head and report null.
  return [null, cursor];
}

function parseAuthenticatorData(authData) {
  if (authData.length < 37) throw new Error("That passkey response was too short.");
  const flags = authData[32];
  const counter = new DataView(authData.buffer, authData.byteOffset, authData.byteLength).getUint32(33);
  const parsed = { rpIdHash: authData.slice(0, 32), userPresent: Boolean(flags & 0x01), userVerified: Boolean(flags & 0x04), counter };
  if (flags & 0x40) {
    // Attested credential data: aaguid, credential id, then the COSE public key.
    let offset = 37 + 16;
    const length = (authData[offset] << 8) | authData[offset + 1];
    offset += 2;
    parsed.credentialId = authData.slice(offset, offset + length);
    offset += length;
    parsed.coseKey = cbor(authData, offset)[0];
  }
  return parsed;
}

// SubjectPublicKeyInfo for a P-256 point: the 91-byte DER every browser and Worker accepts.
function spkiFromCose(cose) {
  if (!cose || cose[1] !== 2) throw new Error("That passkey uses a key type this site does not support.");
  if (cose[3] !== -7) throw new Error("That passkey is not ECDSA/SHA-256.");
  if (cose[-1] !== 1) throw new Error("That passkey is not on the P-256 curve.");
  const x = cose[-2], y = cose[-3];
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new Error("That passkey public key is malformed.");
  const der = new Uint8Array(91);
  const bytes = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04];
  der.set(bytes, 0);
  der.set(x, bytes.length);
  der.set(y, bytes.length + 32);
  return der;
}

// Authenticators sign in DER, but WebCrypto (BoringSSL) verifies ECDSA over the raw r||s form:
// SEQUENCE { INTEGER r, INTEGER s } becomes two 32-byte values, left-padded. Node's crypto.verify
// takes DER and Chrome's get() hands back DER, so this is exactly the seam that fails silently.
function derSignatureToRaw(der) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der[0] !== 0x30) throw new Error("That passkey signature was not readable.");
  let offset = 1;
  if (der[offset] & 0x80) offset += 1 + (der[offset] & 0x7f); else offset += 1;
  const readInteger = () => {
    if (der[offset] !== 0x02) throw new Error("That passkey signature was not readable.");
    let length = der[offset + 1], start = offset + 2;
    if (length & 0x80) { const size = length & 0x7f; length = 0; for (let index = 0; index < size; index++) length = length * 256 + der[start + index]; start += size; }
    offset = start + length;
    let value = der.subarray(start, start + length);
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw new Error("That passkey signature was not readable.");
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = readInteger(), s = readInteger(), raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

function readClientData(value, expectedType, expected) {
  let data;
  try { data = JSON.parse(decoder.decode(fromBase64Url(value))); } catch { throw new Error("That passkey response was not readable."); }
  if (data.type !== expectedType) throw new Error("That passkey response has the wrong type.");
  if (data.challenge !== expected.challenge) throw new Error("That passkey challenge did not match. Try again.");
  if (data.origin !== expected.origin) throw new Error("That passkey came from a different site.");
  return data;
}

function checkRpId(parsed, expected) {
  if (base64Url(parsed.rpIdHash) !== base64Url(expected.rpIdHash)) throw new Error("That passkey belongs to a different site.");
  if (!parsed.userPresent) throw new Error("The device did not confirm a person was present.");
  if (!parsed.userVerified) throw new Error("Confirm it is you with your fingerprint or device unlock.");
}

/**
 * Registration: prove the response answers our challenge, then hand back the credential id and the
 * public key in SPKI form. Attestation is deliberately "none" - the authenticator's identity is not
 * interesting here, and demanding it would mean a metadata service.
 */
export async function verifyRegistration(response, expected) {
  readClientData(response.clientDataJSON, "webauthn.create", expected);
  let attestation;
  try { attestation = cbor(fromBase64Url(response.attestationObject))[0]; } catch { throw new Error("That passkey registration was not readable."); }
  if (!attestation || !(attestation.authData instanceof Uint8Array)) throw new Error("That passkey registration carried no authenticator data.");
  const parsed = parseAuthenticatorData(attestation.authData);
  checkRpId(parsed, expected);
  if (!parsed.credentialId || !parsed.credentialId.length) throw new Error("That passkey registration carried no credential.");
  const credentialId = base64Url(parsed.credentialId);
  if (response.id && response.id !== credentialId) throw new Error("That passkey credential id did not match its data.");
  return { credentialId, publicKey: base64Url(spkiFromCose(parsed.coseKey)), counter: parsed.counter };
}

/**
 * Assertion: verify the signature over authenticatorData || SHA-256(clientDataJSON) with the stored
 * key, and treat a counter that fails to advance as a cloned authenticator.
 */
export async function verifyAssertion(response, expected, stored) {
  readClientData(response.clientDataJSON, "webauthn.get", expected);
  const authData = fromBase64Url(response.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  checkRpId(parsed, expected);
  const signed = new Uint8Array([...authData, ...(await sha256(fromBase64Url(response.clientDataJSON)))]);
  const key = await crypto.subtle.importKey("spki", fromBase64Url(stored.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derSignatureToRaw(fromBase64Url(response.signature)), signed);
  if (!valid) throw new Error("That passkey signature did not verify.");
  if (stored.counter > 0 && parsed.counter > 0 && parsed.counter <= stored.counter) throw new Error("This passkey was used more than once in a way a real device would not - sign in with your key and remove it.");
  return { counter: parsed.counter };
}
