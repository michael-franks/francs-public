# Francs

A self-hosted budgeting web app for a two-person New Zealand household. It pulls
your transactions and balances from your bank via [Akahu](https://akahu.nz)
open banking (**read-only**), auto-categorises spending, tracks budgets against
actuals, and helps you settle a shared credit card across your accounts.

It is a single-page front end (`index.html`, plain HTML + JS, with Chart.js
bundled locally — no CDN) served by a small Node/Express backend (`server.js`)
that talks to Akahu and stores your data as JSON files on disk. The front end
makes no third-party requests; the server talks only to Akahu (to read your bank
data) and, optionally, your own SMTP server (for reminder emails) and CoinGecko
(to price any crypto holdings you choose to add).

> Money amounts, categories and accounts ship with a generic demo household so
> the app is usable out of the box. Edit them in **Settings**, or let your real
> data flow in once you connect Akahu.

## What you get

- **Home** — budget vs actual at a glance, "within means" check, available cash.
- **Insights** — spending by category, income vs spending over time, trends.
- **Balances** — current account balances over time, including a check that the
  bills account holds enough to cover upcoming fixed costs, and a student-loan
  tracker driven by your income deductions.
- **Investments** — live KiwiSaver / managed-fund / wallet balances (and optional
  self-custody crypto) with a simple compound-growth retirement projection.
- **Settle** — sync the bank, review new transactions, and work out how much each
  account should transfer to the credit card to settle it.
- **Settings** — accounts, cards, budget categories, income earners and funding.

## Prerequisites

- [Node.js](https://nodejs.org) 18+ (20 LTS recommended).
- An Akahu account with a **personal app** and your bank connected. Sign up and
  create one at [my.akahu.nz](https://my.akahu.nz). From the developer dashboard
  you will get two tokens for your app:
  - an **App token** (`app_token_...`)
  - a **User token** (`user_token_...`)

  Akahu access here is read-only — the app never initiates payments.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your env file and fill in your Akahu tokens
cp .env.example .env
#    then edit .env and set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN

# 3. Start the server
node server.js

# 4. Open the app
#    http://localhost:3000
```

On first run the server serves `index.html` and exposes a small JSON API under
`/api/*`. Use the **Settle** screen's "Fetch & sync" to pull transactions from
Akahu, or `curl -X POST http://localhost:3000/api/fetch`.

There is also a `setup.sh` for installing it as a `systemd` service on a Linux
host, if you want it running permanently.

## Run with Docker

```bash
# 1. Put your Akahu tokens in a .env file next to docker-compose.yml
cp .env.example .env
#    then edit .env and set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN

# 2. Build and start
docker compose up -d

# 3. Open the app
#    http://localhost:3000
```

Your data persists in the named `budget-data` volume (mounted at `/data` inside
the container). Inside the container `HOST` is `0.0.0.0` so the published port
works — the server prints a "no authentication" warning on start, which is
expected. Only port `3000` is published to your host; do **not** expose it to a
public interface without Cloudflare Access or a VPN in front.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `AKAHU_APP_TOKEN` / `AKAHU_USER_TOKEN` | Akahu credentials (required) |
| `PORT` / `HOST` | Where the server listens (default `3000` / `127.0.0.1`, localhost-only). Set `HOST=0.0.0.0` to expose it — but the API has no login, so only do that behind Cloudflare Access or a VPN. |
| `DATA_DIR` | Where JSON data is stored (default `./data`) |
| `INITIAL_FETCH_FROM` | How far back to fetch on first sync (ISO date) |
| `APP_URL` | Public URL used in reminder emails / CORS |
| `SMTP_*`, `CARD_REMINDER_*` | Optional credit-card settlement reminder emails |
| `REQUIRE_CF_ACCESS`, `ALLOWED_EMAIL` | Optional Cloudflare Access enforcement |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional web-push keys — enable install-app notifications (`npx web-push generate-vapid-keys`) |

## Install as an app (PWA)

The app is installable — on a phone it runs full-screen with its own icon and no
browser bars, and its shell works offline (it loads from cache and renders your
locally-stored data; live bank data still needs the network).

- **Install**: Android/Chrome — "Install app" from the browser menu. iPhone/Safari —
  Share → "Add to Home Screen".
- **Notifications** (optional): once you set the `VAPID_*` keys above, a "Notifications"
  toggle appears in Settings. Enable it to get a push when the credit card is due to be
  settled (this fires alongside the email reminder, if configured). Generate keys once
  with `npx web-push generate-vapid-keys`, put them in your `.env`, and restart.
- **iOS note**: web push only works once the app is added to the home screen, on
  iOS 16.4+, and the site is served over HTTPS (`localhost` is exempt for testing).

## Where your data lives

Everything is stored as plain JSON in `DATA_DIR` (default `./data`):
`transactions.json`, `accounts.json`, `state.json` (your budget config + ledger),
`balance-log.json`, and `fetch-meta.json`. These files contain your financial
data and are git-ignored — keep them private and back them up yourself. The
budget config also caches in your browser's `localStorage`.

To track self-custody crypto (priced live via CoinGecko), create
`DATA_DIR/crypto-holdings.json` as an array of `{ id, sym, amount }`, where `id`
is the [CoinGecko](https://www.coingecko.com) id — e.g.
`[{ "id": "bitcoin", "sym": "BTC", "amount": 0.05 }]`. It ships empty (crypto
off), and lives under `DATA_DIR` so your holdings stay out of git.

## Tests

```bash
node settlement.test.js   # credit-card settlement engine
node migrations.test.js   # schema-migration helper
```

## Notes

- Built for New Zealand (NZD, Akahu, en-NZ formatting).
- This is a personal project shared as-is, **with no warranty of any kind**. It is
  not financial advice. Review the code before connecting it to your bank, and
  use it at your own risk.

## License

MIT
