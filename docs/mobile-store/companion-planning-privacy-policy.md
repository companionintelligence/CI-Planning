# Companion Planning for iOS and Android — Privacy Policy

**Effective date:** November 17, 2026  
**Publisher:** Companion Intelligence, Inc.  
**Contact:** support@ci.computer

This policy describes the Companion Planning iOS and Android apps (the “App”). It supplements the [Companion Intelligence Privacy Policy](https://ci.computer/privacy-policy). The privacy practices of the server you connect to are set by that server’s operator and may differ from this policy.

## The App and your server

The App is a mobile client for a Companion Planning server. When you connect it, the App sends requests to the server address you entered. The server operator can process the information sent to that server. Companion Intelligence does not receive your planning information merely because you use the App. If you choose a server operated by Companion Intelligence, that server’s operator will receive the information it processes.

## Information stored on your device

The App stores the server address you chose, a session cookie used to keep you signed in, cached information needed by the interface, and edits you make while offline. Offline edits are sent to the selected server when a connection is available. Changing servers discards unsynced edits so they are not sent to a different server by mistake. If you enable the optional device app password, a salted verifier is held in the iOS Keychain or Android Keystore-backed secure storage, with device-only storage and no cloud sync. iOS may retain this Keychain item after uninstall; on reinstall, use the app-lock reset option to sign out and clear it. Removing the App does not delete server data.

When you choose Companion Portal sign-in, the system browser opens the Portal and returns to the Planning server you selected. The app holds a temporary PKCE verifier on-device; the Planning server returns a short-lived, single-use handoff code to the app, which exchanges it for that server's normal session. The app link does not carry a session cookie or reusable access token.

If you enable device reminders, the App schedules generic local notifications on your device from upcoming reminders on your selected server. Notification text does not include task names. The App refreshes scheduled reminders when it opens or resumes; changes made on the server while the App is closed may not appear until the next refresh. Local notifications do not use Apple or Google push services and do not send a device push token.

## AI models and integrations

The App does not include or run an AI model on the phone. AI features, when enabled, run through the model endpoint configured for the Companion Planning server. An operator may configure a local model on a Hub or other computer they control, or may configure a remote AI provider. The operator determines which endpoint is used; information submitted for an AI feature may be processed by that endpoint under the operator’s configuration and the provider’s terms.

The server operator may also enable integrations, such as calendar or memory services. Those integrations may send information to the connected provider. Review the server operator’s settings and the provider’s privacy terms before enabling them.

## Analytics, diagnostics, and performance data

The iOS and Android Apps do not send analytics, usage metrics, crash reports, or performance telemetry to Companion Intelligence. The App has no advertising or analytics SDK configured for these reports. This statement concerns the mobile App; the server operator may separately configure server-side diagnostics or third-party integrations.

## Retention and deletion

The App’s on-device cache and unsynced edits are stored on your device. Planning records and account information are stored by the server you use, under the control of that server’s operator. Contact that operator to request access, correction, or deletion of server-side information and to ask about backups and retention. Deleting the App does not delete server-side records.

## Security

The App uses the operating system’s network and cookie facilities to communicate with the server you select. Use HTTPS for servers reached over the internet. Plain HTTP may expose traffic to other devices on the network. No method of transmission or storage is perfectly secure; the server operator is responsible for securing the server and its backups.

## Children

The App is not directed to children under 13, and Companion Intelligence does not knowingly collect children’s personal information through the App.

## Changes and contact

We may update this policy when the App’s data practices change. The current version will be available at the public privacy-policy URL listed in the App’s settings and store listing. For questions about this policy, contact [support@ci.computer](mailto:support@ci.computer).

## Publisher information

Companion Intelligence, Inc.  
131 Continental Drive, Suite 305  
Newark, DE 19713-4324, United States
