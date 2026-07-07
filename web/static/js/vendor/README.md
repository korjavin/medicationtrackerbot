# Vendor Directory

This directory contains vendored third-party code that is necessary for the application to function in restricted environments (e.g. strict CSP).

## @elevenlabs/client

Version: `1.7.0`
License: MIT
Repository: https://github.com/elevenlabs/elevenlabs-js

This SDK is bundled locally to avoid pulling it from `https://esm.sh` at runtime, ensuring that `script-src` can remain strictly `'self'` on the DEK-bearing page (preventing supply-chain XSS).

### Re-generating the bundle

To deterministically re-generate the bundle from the pinned version:

```bash
cd web/static/js/vendor
npm install
./build-elevenlabs.sh
```

**Modifications from upstream:**
- `window.log` global assignment is stripped during the build to avoid polluting the global namespace.
