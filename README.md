# kassos.art

**KAS·SOS — turn Kaspa into help that arrives.**

Humanitarian donation site. Donations in Kaspa (KAS) are on-chain, fully traceable,
and **100% redistributed** to people in need. A personal initiative by Rexhep Kllokoqi.

- **Live:** https://kassos.art (19 languages, RTL-aware)
- **Community & governance:** https://kassos.art/community/ — KASSOS holder leaderboard + votes

## How it works

Static site (HTML/CSS/JS), no backend for the public pages:

- **Donation tracker** reads the Kaspa REST API (`api.kaspa.org`) — total raised, balance, transactions, live KAS price.
- **Holder leaderboard** reads the Kasplex KRC20 indexer (`api.kasplex.org`) for the `KASSOS` token.
- **QR** for the donation address is a static inline SVG.

## Governance (in progress)

KASSOS holders get a **non-financial** voice in where the next aid batch goes —
recognition, weighted vote and access only. No yield, no payout, no price promise.

- `results/` — immutable, public archive of past vote results (served via CDN).
- `worker/` — Cloudflare Worker collecting **signed** votes (free for voters, no transaction).

## Structure

- `index.html` — main donation site (19-language i18n engine inline)
- `community/index.html` — holder leaderboard + governance
- `*.webp` / `og.jpg` / `qr.svg` — optimized assets
- `robots.txt`, `sitemap.xml`
