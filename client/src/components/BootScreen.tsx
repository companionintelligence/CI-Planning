import { BrandMark } from './BrandMark.js';

/**
 * The screen a person sees while the app works out who they are and what to show.
 *
 * It renders the same markup as the static boot screen in client/index.html, and its styles live
 * there too (`.boot-screen`), so the handover from the first paint to the app is invisible. It
 * replaces the bare spinners the auth gate used to show while it waited on the server.
 */
export function BootScreen() {
  return (
    <div class="boot-screen" role="status" aria-label="Loading Companion Planning">
      <BrandMark size={88} class="boot-mark" />
      <p class="boot-name">Companion Planning</p>
      <div class="boot-progress" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
