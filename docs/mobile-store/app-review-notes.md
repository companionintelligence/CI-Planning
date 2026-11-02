# App Review notes: Companion Planning for iOS (DRAFT)

> For the reviewer. Fill in the bracketed items. The position on account deletion is a proposal for the owner to decide.

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

The app uses https for addresses on the internet. It allows plain http only for addresses on the local network: IP addresses, .local names, unqualified names, and the .lan and .home.arpa names. Those are exempted from App Transport Security in Info.plist, through NSAllowsLocalNetworking and two NSExceptionDomains entries. Arbitrary loads are not allowed.

## Accounts and account deletion (Guideline 5.1.1(v))

- The app does not create accounts. The "New account" control is hidden in the app, and accounts are created on the server by its operator.
- The app offers username and password sign-in only. Companion Portal sign-in is not available in the app yet.
- [Proposed position, for the owner to decide: the app creates no accounts and has no sign-up, so guideline 5.1.1(v) does not require an in-app deletion path. The server's operator manages accounts.]
- Risk: if App Review treats the server's account creation as part of the app, the app would need an in-app deletion path, and the product does not have one yet.

## Export compliance

The app uses only the standard encryption that the operating system provides. ITSAppUsesNonExemptEncryption is set to false.

## Privacy

The privacy manifest declares no tracking and no collected data types. The app sends data only to the server the user enters.

## Device support

iPhone only (TARGETED_DEVICE_FAMILY 1). Minimum iOS version 16.4.
