# Clutch Hub Demo App

![Alpha](https://img.shields.io/badge/status-alpha-orange.svg)
![Experimental](https://img.shields.io/badge/stage-experimental-red.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)

> ⚠️ **ALPHA SOFTWARE** - This project is in active development and is considered experimental. Use at your own risk. Features may not work as expected and APIs may change without notice.

A decentralized ride-sharing application showcasing blockchain integration using the Clutch Hub SDK.

**Documentation:** https://docs.clutchprotocol.io/demo-app/overview

**Created and maintained by [Mehran Mazhar](https://github.com/MehranMazhar)**

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_URL` | Hub API base URL | `http://localhost:3000` |
| `VITE_PUBLIC_NODE_ENDPOINTS` | Comma-separated node WS URLs (network tab) | empty |

Stage auto-detection: `app-stage.*` hostname maps to `api-stage.*`. See [Environments](https://docs.clutchprotocol.io/getting-started/environments).

## Live demos

- https://demo.clutchprotocol.io
- https://app-stage.clutchprotocol.io

## Features

### User Profile Management
- Store public and private keys securely
- Option to remember keys between sessions
- Visual feedback for active profile

### Ride Request
- Interactive map to select pickup and dropoff locations
- Simple fare input
- Automatic transaction signing when keys are stored
- Visual feedback during transaction processing

### Transaction History
- Records all ride requests (successful and failed)
- Collapsible interface to save space
- Persistent storage tied to user's public key

## Security Considerations

- Private keys are optionally stored in the browser's localStorage
- Warning is displayed about the risks of storing private keys
- Keys are never transmitted to any server except during transaction signing
- All blockchain interactions happen client-side

## Decentralization Benefits

This application demonstrates several key blockchain principles:

1. **User sovereignty**: Users own and control their keys
2. **Transparency**: All transactions are recorded and visible
3. **No central authority**: Ride requests are processed by the blockchain network
4. **Trustless operations**: Smart contracts enforce the rules without third-party oversight

## Getting Started

The demo uses **`clutch-hub-sdk-js`** from the **npm registry** (`^1.13.0`). Run `npm update clutch-hub-sdk-js` (or `npm run update:sdk`) to pull a newer published version.

**Live lists:** `src/sdkRealtime.js` calls `subscribeRideRequests` / `subscribeRideOffers` / etc. when the installed SDK defines them (GraphQL over **WebSocket** to `/graphql/ws`). If those methods are missing (older npm package), the same UI falls back to **HTTP polling** so the app still runs.

**Local SDK development:** To point at a sibling repo instead of npm, set `"clutch-hub-sdk-js": "file:../clutch-hub-sdk-js"` in `package.json` and optionally add a Vite `resolve.alias` to `../clutch-hub-sdk-js/src/index.ts` plus a direct `graphql-ws` dependency if you bundle from source.

1. Clone the repository
2. Install dependencies with `npm install`
3. Start the development server with `npm run dev`
4. Visit `http://localhost:5173` in your browser

### Docker

```bash
# Build (API URL defaults to http://localhost:3000)
docker build -t clutch-hub-demo-app .

# Run
docker run -p 5173:80 clutch-hub-demo-app
```

Or use [clutch-deploy](https://github.com/clutchprotocol/clutch-deploy) with `--profile demo` to run the full stack including the demo app.

## Development

### Dependencies
- React for UI components
- Leaflet for interactive maps
- Clutch Hub SDK for blockchain interactions (`clutch-hub-sdk-js` from **npm**, so Docker and [GitHub Actions](https://github.com/clutchprotocol/clutch-hub-demo-app/actions) can run `npm ci` without a sibling repo)

### Optional: local SDK checkout
To develop against a local `clutch-hub-sdk-js` clone, use npm link (see the [SDK repo](https://github.com/clutchprotocol/clutch-hub-sdk-js)), or temporarily run `npm install ../clutch-hub-sdk-js` from this directory if the SDK folder sits next to the demo app.

### Local Storage

> **This is a demo, not a wallet.** Keys are generated in the browser and stored in
> `localStorage` **in plain text** — readable by any script on the page, any browser extension,
> and anyone else using the same computer. Clearing site data deletes them irrecoverably. That is
> an acceptable trade for a testnet whose CLT has no value, and it is not acceptable for anything
> else. Never put real funds behind a key created here.
>
> **If you are building on Clutch, do not copy this pattern.** The SDK signs locally, so a
> hardware wallet, an OS keychain or an external signer substitutes in without changing how
> transactions are built or submitted. See
> [Mainnet Readiness](https://docs.clutchprotocol.io/reference/mainnet-readiness) item F1.

Keys are role-scoped, so a passenger and a driver on the same browser are separate accounts:

- `clutch_{passenger|driver}_publicKey` — the account address
- `clutch_{passenger|driver}_privateKey` — the private key, in plain text
- `clutch_demo_role`, `clutch_demo_theme` — which role and theme were last used
- `clutch_tx_{publicKey}` — the last ~10 local transaction records, for the history panel

## Best Practices

The application follows blockchain best practices:
- Minimizes private key exposure
- Uses client-side signing
- Keeps transaction history for transparency
- Provides clear feedback on transaction status

## Project Structure

```
clutch-hub-demo-app/
├── public/
├── src/
│   ├── components/
│   │   └── RideForm.jsx         // Ride request form component
│   ├── App.jsx                  // Main app component
│   ├── main.jsx                 // React entry point
│   └── config.js                // API config (e.g., export const API_URL)
├── package.json
├── vite.config.js
├── README.md
└── .gitignore
```

## Using the Clutch Hub SDK

This app depends on the SDK by path, not by version: `"clutch-hub-sdk-js": "file:../clutch-hub-sdk-js"`.
The `predev` and `prebuild` scripts build that sibling checkout first, so the app always runs against
the SDK source next to it. Changes to the SDK show up here after a rebuild.

The published image is built the same way. `Dockerfile` copies both repos, builds the SDK, then runs
`npm run build` in this app, so an image is a snapshot of both checkouts rather than of an npm
version range.

```bash
npm run dev          # builds the SDK, then starts Vite on 5173
npm run build        # builds the SDK, then builds this app
npm run build:sdk    # rebuild only the SDK
npm run check:sdk    # show which SDK is linked
```

If you want to depend on the registry copy instead, install it explicitly
(`npm install clutch-hub-sdk-js@4.1.0`) and drop the `predev`/`prebuild` hooks. Pin an exact
version if you do: the SDK's 3.0.0 changed the signed wire format, so a range that crosses it
produces transactions the node rejects.

---

Stay true to the philosophy of decentralization and blockchain.

## Author & Maintainer

**Mehran Mazhar**
- GitHub: [@MehranMazhar](https://github.com/MehranMazhar)
- Website: [MehranMazhar.com](https://MehranMazhar.com)
- Email: mehran.mazhar@gmail.com

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
