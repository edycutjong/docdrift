# Sponsor Defense & API Integration: DocDrift

This document details the integration of Anna Platform primitives within DocDrift, proving deep utilization of 5+ SDK methods, and outlines our solutions to platform constraints.

---

## 1. Anna SDK Methods Integrated (7 Methods)

1. **`AnnaAppRuntime.connect()`**: Used in [app.js](bundle/app.js) to perform handshake negotiations and initialize the app session state.
2. **`a.tools.invoke({tool_id, method, args})`**: Drives the core scanning logic, enabling the iframe to invoke Python Executa tools (`project.scan`, `docs.crossref`, and `docs.patchgen`).
3. **`a.storage.set(key, value)`**: Persists active review state, symbol tables, and drift queues to the Anna Persistent Storage in the `app` scope.
4. **`a.storage.get(key)`**: Restores active reviews on reload, enabling developer workflow persistence.
5. **`a.window.open_view(view_name)`**: Launches the multi-view window routing when clicking a drift card in the Workspace, loading `index.html#/drift` in a dedicated panel.
6. **`a.chat.append_artifact(payload)`**: Appends a vector-rendered SVG status report card to the user's host chat timeline after a patch is exported.
7. **`upload.negotiate` / `upload.confirm`**: Integrates with the host's Cloudflare R2 API to upload `.patch` files and return signed download links.

---

## 2. Platform Limitations & Mitigations

### 2.1. APS KV Storage Budget (256KB cap)
* **Defense**: Large codebases containing thousands of lines of code will easily exceed the 256KB storage limit if raw text is persisted. We resolved this by extracting and storing only the SHA-256 signatures of symbol structures in APS, rather than full files.

### 2.2. Executa Network Restrictions
* **Defense**: The air-gapped Executa cannot query external APIs directly due to strict sandbox security. We defended this by routing all AI processing requests via the host's reverse-RPC `sampling/createMessage` interface, ensuring zero plaintext outbound leakage.
