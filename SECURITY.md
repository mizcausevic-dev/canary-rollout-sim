# Security Policy

This project is a static, client-side application. It has no backend, stores nothing server-side, and sends no user input over the network. All processing happens in your browser.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on this repository rather than a public issue. Expect an acknowledgement within 5 business days.

## Design notes

- Content-Security-Policy restricts scripts to same-origin modules (`script-src 'self'`).
- User input is rendered with `textContent` or escaped before insertion; no `eval`, no `innerHTML` with untrusted strings.
- Input size is bounded to keep the UI responsive with hostile or oversized input.
