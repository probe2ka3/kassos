// kassos-vote — Cloudflare Worker
// Collects KASSOS holder votes for the kassos.art charity (governance only).
// Phase 1 (this deploy): read endpoints + safe placeholder for /vote.
// Phase 2: signed-vote verification (Kaspa schnorr) + tier-weighted tally.

const ALLOWED_ORIGINS = [
  "https://kassos.art",
  "https://www.kassos.art",
  "http://localhost:8099",
];

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health / status
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ service: "kassos-vote", status: "ok", voting: "not_open" }, 200, origin);
    }

    // Read the current tally for a given vote id
    if (url.pathname === "/tally" && request.method === "GET") {
      const vote = url.searchParams.get("vote") || "current";
      const raw = await env.VOTES.get("tally:" + vote);
      return json({ vote, status: "not_open", tally: raw ? JSON.parse(raw) : {} }, 200, origin);
    }

    // Cast a vote — disabled until signature verification is validated (Phase 2)
    if (url.pathname === "/vote" && request.method === "POST") {
      return json(
        { error: "voting_not_open", message: "Voting is not open yet." },
        503,
        origin
      );
    }

    return json({ error: "not_found" }, 404, origin);
  },
};
