// kassos-vote — Cloudflare Worker (Phase 2)
// Collects KASSOS-holder votes for the kassos.art charity (governance only, non-financial).
// Free for voters: they sign a message in their Kaspa wallet (no transaction).
//
// Flow per vote:
//   1. verify the Kaspa message signature  -> proves the voter controls the address
//   2. read the KASSOS balance (Kasplex)   -> determines the tier weight
//   3. store one vote per address in KV     -> last vote wins
//
// Signature scheme (rusty-kaspa): blake2b-256 keyed with "PersonalMessageSigningHash"
// over the UTF-8 message, then BIP340 schnorr. Pubkey is decoded from the address.

import { schnorr } from "@noble/curves/secp256k1";
import { blake2b } from "@noble/hashes/blake2b";
import { utf8ToBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils";

const ALLOWED_ORIGINS = [
  "https://kassos.art",
  "https://www.kassos.art",
  "http://localhost:8099",
];

const KASPLEX = "https://api.kasplex.org/v1/krc20";
const TICK = "KASSOS";
const SIGN_KEY = utf8ToBytes("PersonalMessageSigningHash");
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// --- tier weighting (DRAFT thresholds, governance only — to finalise) ---
function tierOf(kas) {
  if (kas >= 10e9) return { name: "Pillar", weight: 10 };
  if (kas >= 1e9) return { name: "Gold", weight: 6 };
  if (kas >= 100e6) return { name: "Silver", weight: 3 };
  if (kas > 0) return { name: "Bronze", weight: 1 };
  return { name: "None", weight: 0 };
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : "https://kassos.art";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders(origin) });
}

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("bad value");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

// kaspa:qr... -> { version, pubkey(Uint8Array) }
function decodeKaspaAddress(addr) {
  const i = addr.indexOf(":");
  if (i < 0) throw new Error("missing prefix");
  const data = addr.slice(i + 1).toLowerCase();
  const fb = [];
  for (const ch of data) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Error("bad char");
    fb.push(v);
  }
  if (fb.length < 10) throw new Error("too short");
  const payload5 = fb.slice(0, fb.length - 8); // drop 8-symbol checksum
  const bytes = convertBits(payload5, 5, 8, false);
  return { version: bytes[0], pubkey: Uint8Array.from(bytes.slice(1)) };
}

function personalMessageHash(message) {
  return blake2b(utf8ToBytes(message), { dkLen: 32, key: SIGN_KEY });
}

function sigToBytes(s) {
  s = String(s).trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return hexToBytes(s);
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

function verifyKaspaSignature(address, message, signature) {
  let decoded;
  try { decoded = decodeKaspaAddress(address); }
  catch (e) { return { ok: false, error: "address decode: " + e.message }; }
  if (decoded.version !== 0 || decoded.pubkey.length !== 32)
    return { ok: false, error: "unsupported address type (need schnorr v0)" };
  const hash = personalMessageHash(message);
  const info = { hashHex: bytesToHex(hash), pubkeyHex: bytesToHex(decoded.pubkey) };
  let ok = false;
  try { ok = schnorr.verify(sigToBytes(signature), hash, decoded.pubkey); }
  catch (e) { return { ok: false, error: "verify: " + e.message, ...info }; }
  return { ok, ...info };
}

async function getKassosBalance(address) {
  const r = await fetch(KASPLEX + "/address/" + address + "/token/" + TICK);
  if (!r.ok) return 0;
  const d = await r.json();
  const row = (d.result && d.result[0]) || null;
  if (!row) return 0;
  return (Number(row.balance || 0) + Number(row.locked || 0)) / 1e8;
}

function voteMessage(voteId, option, address) {
  return "kassos.art governance vote\nvote: " + voteId + "\noption: " + option + "\naddress: " + address;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const method = request.method;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ service: "kassos-vote", status: "ok", phase: 2 }, 200, origin);
    }

    // Debug: verify a raw (address, message, signature) — used to validate the scheme
    if (url.pathname === "/verify-test" && method === "POST") {
      const b = await request.json().catch(() => null);
      if (!b || !b.address || !b.message || b.signature === undefined)
        return json({ error: "need address, message, signature" }, 400, origin);
      return json(verifyKaspaSignature(b.address, b.message, b.signature), 200, origin);
    }

    // Read the tally for a vote
    if (url.pathname === "/tally" && method === "GET") {
      const voteId = url.searchParams.get("vote") || "current";
      const cfgRaw = await env.VOTES.get("config:" + voteId);
      const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
      const list = await env.VOTES.list({ prefix: "vote:" + voteId + ":" });
      const tally = {}; let voters = 0, totalWeight = 0;
      for (const k of list.keys) {
        const val = await env.VOTES.get(k.name);
        if (!val) continue;
        const r = JSON.parse(val);
        tally[r.option] = (tally[r.option] || 0) + r.weight;
        voters++; totalWeight += r.weight;
      }
      return json({
        vote: voteId,
        status: cfg ? (cfg.open ? "open" : "closed") : "not_open",
        title: cfg ? cfg.title : null,
        options: cfg ? cfg.options : [],
        tally, voters, totalWeight,
      }, 200, origin);
    }

    // Cast a vote
    if (url.pathname === "/vote" && method === "POST") {
      const b = await request.json().catch(() => null);
      if (!b) return json({ error: "bad_request" }, 400, origin);
      const { voteId, option, address, message, signature } = b;
      if (!voteId || !option || !address || !message || !signature)
        return json({ error: "missing_fields" }, 400, origin);

      const cfgRaw = await env.VOTES.get("config:" + voteId);
      if (!cfgRaw) return json({ error: "no_active_vote" }, 404, origin);
      const cfg = JSON.parse(cfgRaw);
      if (!cfg.open) return json({ error: "voting_closed" }, 403, origin);
      if (!cfg.options.includes(option)) return json({ error: "invalid_option" }, 400, origin);

      if (message !== voteMessage(voteId, option, address))
        return json({ error: "message_mismatch", expected: voteMessage(voteId, option, address) }, 400, origin);

      const v = verifyKaspaSignature(address, message, signature);
      if (!v.ok) return json({ error: "invalid_signature", detail: v.error || null }, 401, origin);

      const kas = await getKassosBalance(address);
      const t = tierOf(kas);
      if (t.weight <= 0) return json({ error: "no_kassos", message: "You must hold KASSOS to vote." }, 403, origin);

      const rec = { option, weight: t.weight, tier: t.name, balanceKas: Math.round(kas), ts: Date.now() };
      await env.VOTES.put("vote:" + voteId + ":" + address, JSON.stringify(rec));
      return json({ ok: true, recorded: rec }, 200, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  },
};
