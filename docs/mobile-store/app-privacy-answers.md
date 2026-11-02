# App privacy answers (DRAFT)

> For the owner to enter in App Store Connect's App Privacy section and in Google Play's Data safety form. Check each answer against the build before submitting.

## Basis

- The app sends what the user enters only to the server the user enters, and the publisher does not run that server.
- `PrivacyInfo.xcprivacy` declares no tracking and no collected data types.
- The mobile build is made without `VITE_SENTRY_DSN`, so the app starts no error reporting.
- The app bundles its font, makes no third-party requests, and has no analytics or advertising SDK.

## Apple: App Privacy label

- Data collected: none. The label is "Data Not Collected".
- Tracking: no.

## Google Play: Data safety

- Data collected by the developer: none.
- Data shared with third parties: none.
- Data encrypted in transit: yes for servers reached over https. Plain http is not encrypted, and the app allows it for servers on the user's own network. Answer for the normal case, and see the notes below.
- Users can request deletion: data kept on the device is removed when the app is deleted, or when the server address is changed. Server data is deleted by the server's operator. The app creates no accounts (see app-review-notes.md).

## Answers that change

- **A demo server run for review by the publisher.** Anything entered on it is collected by the developer. Declare it on both forms and in the privacy policy.
- **Data sent to a server the user picks.** These answers assume the developer does not collect it, because the developer does not run that server. If Google reads it differently, the transit answer must cover plain http on local networks.
- **Crash or error reporting.** If a DSN is ever built into a mobile build, the app sends errors. Declare it on both forms.
- **Any analytics or SDK added later.** Re-check the privacy manifest and both forms.
