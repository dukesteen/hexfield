# HXFS1 review disposition

The [source-only Claude review](./hxfs1-review-raw.md) examined the files pinned in [the manifest](./hxfs1-review-manifest.sha256). The review ran with tools and MCP disabled. No real save, master, key, or escrow record was included. The fixes below changed source after that snapshot; the raw review and manifest remain unchanged.

1. Plaintext copies: fixed. Encryption retains and wipes its input copy. Decryption retains and wipes the canonical re-encoding. Accepted-share validation retains and wipes store-load copies.
2. Escrow store ownership: fixed. The exporter copies each loaded share before taking wipe ownership. It leaves the provider's returned buffer alone because the store interface does not promise a fresh buffer. A test uses a store that returns its retained byte arrays and verifies they survive export and disposal.
3. Untrusted structure: fixed. HXFS1, safety, and decrypted private JSON now have bounded byte, depth, and lexical-node checks before canonical decoding. The same early check is in `validateOnlineTransferBootstrap`, so HXAR1 public import and transfer bootstrap share the bound. Parsed known byte fields have typed cleanup; the generic recursive wipe was removed. Post-decode schema and object bounds remain. Depth and node regressions cover the public entry point.
4. KDF contention: fixed. A simultaneous derivation returns `full-save-busy`. Passphrases must contain 12 to 1024 characters. A focused test checks contention.
5. Historical safety metadata: fixed. The private binding and AES associated data hash the complete safety record, including revision, seat, public key, and safety bytes. A revision edit now prevents decryption.
6. Invalid export passphrase: fixed. The journal exporter rejects missing or invalid private passphrases before loading the journal or secrets. A test counts zero journal reads for this case.

The additional positive test validates genuine signed accepted shares through the escrow protocol, then exports and opens a complete encrypted private capsule. This tests the path that the original review identified as uncovered.

Validation after these fixes: web TypeScript check, scoped type-aware lint, and nine focused tests across `online-full-save`, `online-transfer-bootstrap`, and the new public preflight test pass. The HXFS1 package remains an inert, read-only import. It does not export or import voting keys, restore live writer authority, or finish the product's full-save UI and worker flow. JavaScript strings and internal WebCrypto copies cannot be reliably erased; the code wipes owned byte buffers where it has a reference.
