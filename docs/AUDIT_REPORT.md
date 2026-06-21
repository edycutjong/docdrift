# Security Audit Report & Threat Model: DocDrift

This report outlines the security invariants, cryptographic envelope details, threat model, and mitigation strategies implemented in DocDrift to protect intellectual property and manage secure transactions.

---

## 1. System Invariants

1. **No Plaintext IP in Storage**: Plaintext source code snippets extracted from the workspace must never be saved in persistent external storage (APS).
2. **Local Cryptographic Key Management**: Symmetric keys used for snippet encryption must be generated inside the local Executa using cryptographically secure pseudorandom numbers (`secrets` module) and kept entirely within the active local user session.
3. **Air-Gapped Compliance**: The symbol walker and regex parser must operate strictly locally, using standard Python library file operations without outbound socket or HTTP requests.

---

## 2. Threat Model & Mitigation Matrix

| Threat | Risk Level | Target | Mitigation Strategy |
|---|---|---|---|
| **Code Leakage in Transit** | High | Source code snippets | Source snippets are encrypted locally using AES-GCM-256 before transmission. Only metadata and hashes are routed when possible. |
| **State Clobbering (Concurrent writes)** | Medium | APS KV storage | Storage writes use `if_match` tags to check for session hashes, preventing concurrent tab writes from clobbering states. |
| **Data Tampering in KV Storage** | Low | Review queue state | State payloads in APS are verified against local SHA-256 signatures before reconstruction. |

---

## 3. Cryptographic Specification

### 3.1. AES-GCM-256 Payload Envelope
* **Key Derivation**: Ephemeral keys are generated using `secrets.token_bytes(32)`.
* **Encryption Mode**: Galois/Counter Mode (GCM) provides both confidentiality and data integrity authentication.
* **Nonce/IV**: A secure random 96-bit initialization vector is generated for each snippet (`secrets.token_bytes(12)`).
* **Format**: The serialized ciphertext package is exported as `key_hex:nonce_hex:ciphertext_hex` representing the encrypted envelope.
