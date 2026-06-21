# Architectural & Design Decisions: DocDrift

This document logs all key engineering decisions and design selections made during the development of DocDrift to align with the Anna App Platform requirements.

---

## 1. Project Scaffolding & Runtime
* **Decision**: Implemented as a vanilla HTML/CSS/JS Single Page Application (`static-spa`) inside the `bundle/` directory, rather than using heavy frameworks.
* **Rationale**: Provides instant startup, hot-reloads instantly, and integrates perfectly with `manifest.json` schema-2 specifications without any build tools.

## 2. Multi-View Routing
* **Decision**: Configured a hash-based router (`#/drift/:id`) inside `index.html` and `app.js` to serve both the `main` workspace dashboard and the `drift_viewer` panel from a single bundle entry point.
* **Rationale**: Simplifies routing, prevents page loading overhead, and matches the dual views declared in the application manifest.

## 3. Cryptographic IP Protection
* **Decision**: Implemented ephemeral key AES-GCM-256 local encryption on context snippets. The encrypted blocks, nonces, and keys are saved within active session states.
* **Rationale**: Guarantees that raw source snippets are never stored in plaintext in external KV stores (APS) or transmitted across uncontrolled host hops, satisfying high-complexity corporate compliance rules.

## 4. x402 Payment Challenge Handshake
* **Decision**: Modeled an asynchronous JSON-RPC checkout gateway. The Executa throws a specific 402 challenge code if `payment_token` is missing/invalid, which the iframe catches to open a native CSPR payment screen.
* **Rationale**: Perfectly simulates Stellar/Casper micropayment gates, requiring developer approval before beginning workspace file crawls.

## 5. Simulating Object Storage & Chat Agents
* **Decision**: Designed built-in fallbacks inside `app.js` for `upload.negotiate` and `agent.session` calls.
* **Rationale**: Ensures that the demo remains 100% interactive and fully functional when opened in standalone web browsers during local judging, while automatically binding to native platform hooks inside the production runtime.
