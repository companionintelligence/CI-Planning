/**
 * Settings → Learning: may this account clear learned data?
 *
 * Settings passes the answer to the panel, which shows the clear buttons only for `true`.
 * It lives here, as a pure function, so the one rule that decides whether a viewer is offered
 * a button has a test: Settings itself has no test file.
 *
 *   - while the account is still loading: null (unknown). The cards show neither a button
 *     nor the read-only note, so nothing flashes and then disappears;
 *   - a viewer: false. A viewer credential can read all four readouts but is answered 403 on
 *     every clear;
 *   - anyone else, including no account at all: true. `auth.me()` is caught to null in
 *     Settings, which is also what a deployment without sign-in gives. The server stays the
 *     authority, so a viewer whose account failed to load sees a button that answers 403,
 *     and the panel then turns every clear off for the session.
 */

/** The only part of the account this rule reads. */
export interface AccountRole {
  role?: string | null;
}

export function learningCanReset(loading: boolean, me: AccountRole | null | undefined): boolean | null {
  if (loading) return null;
  return me?.role !== 'viewer';
}
