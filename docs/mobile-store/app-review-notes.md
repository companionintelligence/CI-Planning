# App Review notes: Companion Planning for iOS (DRAFT)

> For the reviewer. The sections before "Owner notes" are text for App Store Connect. The bracketed items need values only the owner can give. The account-deletion position is the owner's decision, recorded on 2026-11-02. Delete the "Owner notes" section before submitting.

## What the app is

A client for a Companion Planning server. Companion Planning is a planning app that the user runs on their own server, on their own hardware or on a home network. The app shows that server's planner, so without a server it has nothing to show.

## How to test it

1. Open the app. It asks for a server address.
2. Enter: [demo server address]
3. Sign in with username [demo username] and password [demo password].

[The demo server must be running and reachable from the internet for the whole review.]

## Why the app asks for local network access

The user's server is often on their home network, at a LAN address or a name ending in .local, .lan or .home.arpa. The app asks for local network permission so that it can reach that server. It does not scan the network.

## Plain http

Plain http is for servers on the user's own network. On iOS, App Transport Security allows http only for local network addresses and for the .lan and .home.arpa names (NSAllowsLocalNetworking and two NSExceptionDomains entries in Info.plist). Servers reached by an internet name use https. The connect screen says so.

## Accounts and account deletion (guideline 5.1.1(v))

- The app does not create accounts. The sign-up control is hidden in the app, and the sign-up page redirects to sign-in.
- Accounts are created, changed and deleted on the server by its operator. An operator can delete other accounts from within the app. The app does not let a signed-in person delete their own account.
- The app offers username and password sign-in only. Companion Portal sign-in is not available in the app yet.
- Position, decided by the owner on 2026-11-02: the app creates no accounts and has no sign-up, so guideline 5.1.1(v) does not require an in-app deletion path. The server's operator manages accounts. An operator can delete other accounts from the app's Settings. A user cannot delete their own account from the app.
- Risk, accepted by the owner: if App Review treats the server's account creation as part of the app, the app would need an in-app deletion path, and the product does not have one yet.

## Guideline 4.2

Companion Planning is a client for a planning server that the user runs. It is not a wrapper around a website. The app keeps a cache for when the server cannot be reached, keeps changes made offline on the device until they can be sent to the server, and uses native shell features for the status bar and safe area.

## Export compliance

The app uses only the standard encryption that the operating system provides. ITSAppUsesNonExemptEncryption is set to false.

## Privacy

The privacy manifest declares no tracking and no collected data types. The app sends data only to the server the user enters.

## Device support

iPhone only (TARGETED_DEVICE_FAMILY 1). Minimum iOS version 16.4.

## Google Play: cleartext traffic

Play asks why usesCleartextTraffic is set. On Android the app sets it for the whole app, because a server on the user's own network often has no certificate, and a network security config matches host names, not private IP ranges. Users are told to use https for servers reached by name or over the internet.

## Owner notes (delete before submitting)

- **Plain http is not enforced in the client.** The connect screen accepts an explicit http:// address for any host. iOS blocks it through App Transport Security, and Android allows it for every host. Decide whether the native shells should refuse http for non-local hosts before the first submission.
- **Guideline 4.2.** The strongest answer is native local notifications for reminders, which are not built. Decide whether to build them before submitting.
- **Demo server.** Someone must run it, keep it up through review, and create the review account on it. Whoever runs it is the developer for privacy purposes; see app-privacy-answers.md.
- **Offline claims.** Confirm the offline cache and offline changes on a device before submitting. This draft takes them from the privacy draft and the shell code.
