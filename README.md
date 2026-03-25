# Viagoco IPL Tickets

IPL ticket marketplace built with HTML/CSS/JS frontend + Node/Express backend.

## Run locally

```bash
npm install
npm run dev
```

Open: [http://localhost:3000](http://localhost:3000)

## What is connected

- Live ticket inventory API (mock or external feed)
- Match status API integration (Upcoming / Running / Completed)
- IPL status source defaults to TheSportsDB free feed
- SabPaisa checkout integration + Razorpay + CCAvenue + demo fallback mode

## API endpoints

- `GET /api/config`
- `GET /api/matches`
- `GET /api/matches/:slug`
- `GET /api/live`
- `GET /api/matches/status`
- `POST /api/checkout/create-order`
- `POST /api/checkout/verify`
- `POST /api/checkout/sabpaisa/response` (gateway callback)
- `POST /api/checkout/ccavenue/response` (gateway callback)

## Environment variables

Copy `.env.example` to `.env`:

```bash
PORT=3000
CHECKOUT_PROVIDER=sabpaisa
NEXT_PUBLIC_RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
SABPAISA_CLIENT_CODE=
SABPAISA_TRANS_USER_NAME=
SABPAISA_TRANS_USER_PASSWORD=
SABPAISA_AUTH_KEY=
SABPAISA_AUTH_IV=
SABPAISA_ENV=stag
SABPAISA_CALLBACK_BASE_URL=
SABPAISA_CHANNEL_ID=web
CCAVENUE_MERCHANT_ID=
CCAVENUE_ACCESS_CODE=
CCAVENUE_WORKING_KEY=
CCAVENUE_ENV=test
CCAVENUE_REDIRECT_BASE_URL=
TICKET_FEED_PROVIDER=mock
TICKET_FEED_URL=
TICKET_FEED_BEARER_TOKEN=
MATCH_STATUS_PROVIDER=thesportsdb
SPORTSDB_API_KEY=3
SPORTSDB_IPL_LEAGUE_ID=4460
MATCH_STATUS_REFRESH_MS=60000
```

## Notes

- `MATCH_STATUS_PROVIDER=thesportsdb` pulls match states from TheSportsDB and maps them to local IPL cards.
- If status API fails, the app automatically falls back to schedule-based status inference so UI keeps working.
- `CHECKOUT_PROVIDER=sabpaisa` forces SabPaisa as the active gateway (falls back to demo if SabPaisa keys are missing).
- Set `CHECKOUT_PROVIDER=razorpay` only when you want Razorpay as primary gateway.
- Set `CHECKOUT_PROVIDER=ccavenue` only when you want CCAvenue as primary gateway.
- For SabPaisa callbacks in production, set `SABPAISA_CALLBACK_BASE_URL` to your public HTTPS base URL.
- For CCAvenue callbacks in production, set `CCAVENUE_REDIRECT_BASE_URL` to your public HTTPS base URL.


