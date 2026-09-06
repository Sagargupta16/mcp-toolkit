# Security Policy

## Beta status

This is beta software (`0.x`). The auth, rate limit, and CORS packages are not yet
recommended for production traffic from untrusted callers. Read the
[limitations](README.md#limitations-and-compatibility) before relying on any of them as
a security boundary -- notably that all state is in-process memory, the JWT verifier is
HMAC-only, and `withCors` is an origin allowlist rather than real CORS.

## Reporting a vulnerability

Report vulnerabilities to sg85207@gmail.com. Please include a description, affected
package and version, and reproduction steps.

Do not open a public issue for a vulnerability until a fix is released.
