# Better Auth on celld: feasibility

**Likely viable through D1; not integration-tested or included in the installer.**

celld 0.6.1 implements a D1-compatible binding backed by SQLite inside a cell. Better Auth documents use of Kysely dialects, including the community Cloudflare D1 dialect; its Drizzle adapter is another possible path. This avoids maintaining a bespoke Better Auth adapter over raw User DO SQL. Runtime compatibility still needs a spike: Cloudflare-style bindings alone do not prove that Better Auth's crypto, async context and dependencies run unchanged on celld.

Suggested split:

- **Auth D1 database:** Better Auth identities, login sessions, linked identity-provider accounts and verification records. Keep global identity lookup here, rather than scatter email/token lookups across User DOs.
- **User DO:** the existing Directory behavior, scoped by the verified Better Auth user ID: provider credentials, GitHub/Linear tokens, model defaults, session directory/subscriptions.
- **Session DO:** immutable owner ID, sandbox and transcript. Scope artifacts and snapshots to that owner/session. Check ownership before HTTP, WebSocket, preview, terminal, download, restore or deletion access. A UUID is not authorization.

Do not confuse Better Auth identity-provider accounts with pi-ai's model-provider sign-ins. The current `/api/auth/login`, `/api/auth/finish`, `/api/auth/logout`, and `/api/auth/callback` routes belong to model sign-in; rename/scope them before mounting Better Auth's conventional `/api/auth/*` routes. Model OAuth callbacks must be correlated to the initiating user and login attempt.

## Spike before adopting

1. Pin Better Auth and a D1-capable adapter; bundle a minimal worker on celld 0.6.1.
2. Generate schema and apply via `celld d1 migrations apply`. D1 forbids arbitrary BEGIN/SAVEPOINT; don't enable unsupported adapter transactions.
3. Verify signup/login, session-cookie validation, logout/revocation, restart persistence and a real OAuth round trip behind the same private HTTPS origin.
4. Verify trusted origin/base URL, Secure/HttpOnly/SameSite cookies, CSRF and WebSocket Origin checks. Don't trust client-supplied forwarded identity headers.
5. Verify cross-user denial on every session surface; migrate existing singleton state to the initial owner deliberately.
6. Only then consider public ingress or multi-user rollout. BYOK doesn't replace resource limits or tenant isolation.

## Sources

- [celld 0.6.1 D1 implementation and differences](https://github.com/denoland/celld/blob/v0.6.1/docs/services/d1.md)
- [Better Auth relational adapters / Kysely dialects](https://www.better-auth.com/docs/adapters/other-relational-databases)
- [Better Auth custom adapter guide](https://www.better-auth.com/docs/guides/create-a-db-adapter)
- [Kysely D1 dialect](https://github.com/aidenwallis/kysely-d1)
