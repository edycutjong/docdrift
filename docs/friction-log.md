# Developer Friction Log — DocDrift on Anna Platform

This document captures developer experience feedback, platform integration learnings, and friction points encountered while building DocDrift on the Anna AI-Native App platform.

---

## 1. The Good: Platform Strengths

* **Native Stdio Executas**: The local python Executa process architecture is exceptional. Walking local files directly in a secure user-controlled sandbox eliminates the latency of syncing repos to remote clouds.
* **Unified Zero-Key AI Sampling**: Calling `sampling/createMessage` via reverse RPC from the Executa is a massive developer experience win. It eliminates the need for managing LLM API keys, handling local billing, or configuring model settings.
* **Flexible Multi-View UX**: Defining independent views like `main` and `drift_viewer` in the manifest, and launching them natively via `window.open_view()`, makes building clean, focused developer tools straightforward.

---

## 2. Friction Points & Solutions

### 2.2. APS Storage Constraints (256KB KV Limit)
* **Friction**: Storing parsed codebase symbols and detailed drift reports in Anna Persistent Storage (APS) quickly exhausts the 256KB storage quota for larger repositories.
* **Solution**: We implemented local SHA-256 symbol hashing and AES-GCM-256 snippet encryption. By hashing symbol signatures and storing only brief metadata, we reduced storage requirements from O(N) snippet text size to O(N) constant hashes, while encrypting the sensitive contents to guarantee security.

### 2.3. Air-Gapped Network Isolation vs. LLM Sampling
* **Friction**: The sandboxed Executa subprocess operates with restricted network access to prevent proprietary codebase IP leaks. However, the plugin must invoke the LLM to classify drift.
* **Solution**: The reverse-RPC interface over stdio allows the Executa to route LLM requests securely through the host shell. By encrypting the local snippets using AES-GCM-256 before transit/storage, the codebase IP is safeguarded.
