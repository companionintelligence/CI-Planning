# Native Companion Portal sign-in

The mobile app opens Companion Portal in the system browser and keeps the user's selected Planning server as the OAuth client. Portal's OIDC redirect goes to that server's callback; it does not go directly to an app URL.

## Redirect URI configuration

For a deployed Planning server, register this callback URI for the `ci-planning` OIDC client in Companion Portal:

```text
https://<planning-server-public-host>/api/auth/ciportal/callback
```

Set `CIPORTAL_REDIRECT_URI` to that exact URI when it differs from `${PUBLIC_BASE_URL}/api/auth/ciportal/callback`. The Companion Portal first-party `ci-planning` client already allows the `/api/auth/ciportal/callback` path on provisioned Planning hosts. Self-hosted servers must use a public HTTPS host that Companion Portal authorizes; local-open loopback deployments use the server's loopback callback behavior.

The registered OAuth redirect must remain the server callback above. The app callback below is only for the final short-lived handoff from the Planning server to the installed app:

```text
com.companionintelligence.planning://auth/callback
```

## Handoff and failure behavior

The app creates a PKCE verifier, retains it locally for at most ten minutes, and sends only its S256 challenge to the Planning server. After Portal sign-in, the server creates a random one-time ticket, stores only its hash, and redirects to the fixed app callback. The ticket expires after two minutes and can only be redeemed with the matching verifier at the same selected Planning server. The server then sets that server's normal session cookie on the app's native HTTP client. The deep link never contains a session cookie or reusable access token.

Cancellation returns to the app without creating a session. Expired handoffs ask the person to sign in again. A Hub account without organization access receives an invitation instruction; a Portal identity without a Planning account gets the existing account/operator explanation. First-time account creation still requires the explicit confirmation page.

The final FTUE step optionally offers a separate per-device app password. It is disabled by default, stored as a salted verifier in device-only secure storage, and requested whenever the app returns from the background. It is not sent to the Planning server or Companion Portal. If the person forgets it, the reset action signs out from the selected Planning server, so Portal sign-in is required again.

## Store configuration

The iOS URL scheme and Android browsable intent filter are registered in their native project files using the app's bundle/application ID. Keep those values aligned with `com.companionintelligence.planning` and with `mobile/*/capacitor.config.ts`.
