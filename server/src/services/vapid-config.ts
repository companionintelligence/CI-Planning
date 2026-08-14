import webpush from 'web-push';
import { store } from '../db/store.js';
import { config } from '../lib/config.js';
import { seal, open, loadKek } from '../lib/crypto/index.js';
import { logger } from '../lib/logger.js';

/**
 * Automatic Web Push (VAPID) key provisioning (ship-readiness follow-up).
 *
 * Web Push used to stay dormant until an operator ran `npx web-push generate-vapid-keys`
 * and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY by hand. That is now automatic: on first
 * boot, if no VAPID env vars are set and no stored pair exists, the server generates a
 * keypair (`webpush.generateVAPIDKeys()`), persists it in `app_config`, and hydrates the
 * config singleton — mirroring services/google-config.ts. The public key is stored in the
 * clear (it is published to every browser that subscribes); the private key is KEK-sealed
 * (AES-256-GCM, the same infrastructure as connection_tokens) when CP_KEK_B64 is available.
 *
 * Precedence: an explicit env keypair (both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY) is
 * authoritative — hydration then never touches the singleton or the DB. This is the same
 * env-pin convention google-config follows; both read it from `config.pins`.
 *
 * KEK fallback: unlike the Google client (whose OAuth token storage HARD-requires a KEK),
 * a VAPID private key has no such downstream dependency, and staying dormant would defeat
 * the "push is automatic" promise for the common no-KEK appliance. So when CP_KEK_B64 is
 * absent the private key is stored UNSEALED (plaintext) with a loud warning — the key only
 * authorizes sending pushes to THIS app's own subscribers, a far lower-stakes secret than
 * a third-party OAuth token, and the DB already lives on the operator's own disk.
 *
 * Stability: the pair is generated ONCE and reused across restarts — rotation would
 * invalidate every existing push subscription. A stored-but-undecryptable private key
 * (KEK removed or rotated away) therefore keeps push dormant rather than regenerating.
 */

const KEY_PUBLIC = 'vapid_public_key'; // plaintext — public by design
const KEY_PRIVATE = 'vapid_private_key'; // self-describing JSON envelope (sealed or plaintext)

// Captured at module load, mirroring google-config's ENV_* capture. A full env keypair
// pins the config (config.pins.vapid); a lone half of the pair is a misconfiguration we
// refuse to auto-heal over (generating would clobber the operator's one deliberate key).
const ENV_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const ENV_PRIVATE = process.env.VAPID_PRIVATE_KEY;

/** Private-key envelope: either a KEK-sealed blob or an unsealed plaintext key. */
type StoredPrivate =
  | { sealed: true; iv: string; authTag: string; ciphertext: string; key_version: number }
  | { sealed: false; key: string };

async function readValue(key: string): Promise<string | null> {
  const row = await store().prepare(`SELECT value FROM app_config WHERE key = ?`).get<{ value: string }>(key);
  return row?.value ?? null;
}

async function writeValue(key: string, value: string): Promise<void> {
  await store()
    .prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(key, value);
}

/** Whether a KEK is configured (and decodes) — decides seal-vs-plaintext at rest. */
export async function kekAvailable(): Promise<boolean> {
  try {
    await loadKek();
    return true;
  } catch {
    return false;
  }
}

type ReadPrivateResult =
  | { status: 'ok'; key: string; sealed: boolean }
  | { status: 'absent' }
  | { status: 'unreadable' }; // stored, but the sealing KEK is gone/rotated — do NOT regenerate

/**
 * A corrupt/incomplete envelope has no recoverable key material, so regenerating is the
 * only route back to a working state — treat it as absent. This is deliberately distinct
 * from a well-formed sealed blob we merely can't decrypt right now (KEK gone/rotated),
 * which stays 'unreadable'/dormant to avoid rotating the keypair.
 */
function malformedPrivate(why: string): ReadPrivateResult {
  logger.warn(`vapid-config: stored VAPID private key envelope is malformed (${why}) — will regenerate`);
  return { status: 'absent' };
}

/** Decode + validate the stored private key envelope. */
async function readStoredPrivate(): Promise<ReadPrivateResult> {
  const raw = await readValue(KEY_PRIVATE);
  if (!raw) return { status: 'absent' };

  let env: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return malformedPrivate('not an object');
    env = parsed as Record<string, unknown>;
  } catch {
    return malformedPrivate('not valid JSON');
  }

  if (env.sealed === false) {
    // Unsealed envelope — must carry a non-empty string key.
    if (typeof env.key !== 'string' || !env.key) return malformedPrivate('unsealed key missing');
    return { status: 'ok', key: env.key, sealed: false };
  }

  if (env.sealed === true) {
    // Sealed envelope — must carry the hex fields + a numeric key_version before we can even
    // attempt to open it. An incomplete blob is corrupt (regenerate); a complete-but-
    // undecryptable one falls to the catch below and stays dormant.
    if (
      typeof env.iv !== 'string' ||
      typeof env.authTag !== 'string' ||
      typeof env.ciphertext !== 'string' ||
      typeof env.key_version !== 'number'
    ) {
      return malformedPrivate('sealed blob incomplete');
    }
    try {
      const key = open(
        { iv: env.iv, authTag: env.authTag, ciphertext: env.ciphertext },
        await loadKek(env.key_version),
      );
      return { status: 'ok', key, sealed: true };
    } catch (err) {
      // Sealed, but the KEK is missing or rotated away. Regenerating here would silently
      // rotate the keypair and kill every push subscription — refuse, stay dormant.
      logger.warn('vapid-config: cannot open the sealed VAPID private key', {
        err: (err as Error).message,
      });
      return { status: 'unreadable' };
    }
  }

  // `sealed` is missing or not a boolean — unrecognized shape.
  return malformedPrivate('unrecognized envelope shape');
}

/** Generate a fresh keypair and persist it (private sealed when a KEK is available). */
async function generateAndStore(): Promise<{ publicKey: string; privateKey: string; sealed: boolean }> {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const sealed = await kekAvailable();
  const envelope: StoredPrivate = sealed
    ? { sealed: true, ...seal(privateKey, await loadKek()), key_version: config.kek.currentVersion }
    : { sealed: false, key: privateKey };
  await store().transaction(async () => {
    await writeValue(KEY_PUBLIC, publicKey);
    await writeValue(KEY_PRIVATE, JSON.stringify(envelope));
  });
  return { publicKey, privateKey, sealed };
}

/**
 * When VAPID_SUBJECT is not pinned in the env, prefer a real operator address over the
 * synthetic `mailto:admin@companion.local` default — push services email this address on
 * delivery problems. Best-effort: any owners-table quirk falls back to the config default.
 */
async function applyDerivedSubject(): Promise<void> {
  if (process.env.VAPID_SUBJECT) return; // env pins the subject
  try {
    const row = await store()
      .prepare(
        `SELECT email FROM owners
         WHERE role = 'operator' AND email IS NOT NULL AND email <> ''
         ORDER BY rowid LIMIT 1`,
      )
      .get<{ email: string }>();
    if (row?.email) config.vapidSubject = `mailto:${row.email}`;
  } catch {
    /* owners table shape/absence — keep the config default */
  }
}

/**
 * Apply the stored (or freshly generated) VAPID pair to the config singleton. Called at
 * boot after migrations (app.ts), before the push-status check in index.ts. No-op when an
 * env keypair pins the config. Idempotent — generates only when no usable pair exists.
 */
export async function hydrateVapidConfig(): Promise<void> {
  if (config.pins.vapid) return; // env keypair already loaded into config.ts; authoritative.

  if (ENV_PUBLIC || ENV_PRIVATE) {
    // Exactly one half set — a deliberate-but-broken posture. Don't auto-generate over it;
    // push stays dormant because push.ts requires both keys.
    logger.warn(
      'vapid-config: only one of VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY is set — Web Push disabled. ' +
        'Set both to pin a keypair, or unset both to auto-generate one.',
    );
    return;
  }

  const priv = await readStoredPrivate();
  if (priv.status === 'unreadable') {
    logger.error(
      'vapid-config: the stored VAPID private key cannot be decrypted (CP_KEK_B64 missing or rotated) — ' +
        'Web Push disabled. Regenerating would rotate the keypair and invalidate every existing subscription, ' +
        'so it is left dormant. Restore the original CP_KEK_B64, or clear the vapid_* rows in app_config to regenerate.',
    );
    return;
  }

  const pub = await readValue(KEY_PUBLIC);
  let publicKey: string;
  let privateKey: string;
  if (priv.status === 'ok' && pub) {
    publicKey = pub;
    privateKey = priv.key;
  } else {
    const gen = await generateAndStore();
    publicKey = gen.publicKey;
    privateKey = gen.privateKey;
    logger.info('vapid-config: generated a Web Push VAPID keypair', { sealed: gen.sealed });
    if (!gen.sealed) {
      logger.warn(
        'vapid-config: no usable CP_KEK_B64 (unset or invalid) — the VAPID private key is stored UNSEALED (plaintext) ' +
          'in app_config. Set a valid 32-byte base64 CP_KEK_B64 to seal it at rest.',
      );
    }
  }

  config.vapidPublicKey = publicKey;
  config.vapidPrivateKey = privateKey;
  await applyDerivedSubject();
}

export interface VapidConfigState {
  /** Where the effective keypair comes from. */
  source: 'env' | 'generated' | 'dormant';
  configured: boolean;
  subject: string;
  hasStoredPair: boolean;
  /** Whether the stored private key is KEK-sealed at rest (false ⇒ plaintext). */
  sealed: boolean;
  kekAvailable: boolean;
  envPinned: boolean;
}

/** Diagnostic snapshot of the current VAPID posture (never includes key material). */
// Dead surface (see #392): mirrors googleConfigState but NO route exposes it (google's
// has GET /api/google-config); only its test calls this. An operator diagnosing dormant
// push (unsealed key, rotated KEK) sees only push.configured=false without server logs.
export async function vapidConfigState(): Promise<VapidConfigState> {
  const priv = await readStoredPrivate();
  const configured = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
  return {
    source: config.pins.vapid ? 'env' : configured ? 'generated' : 'dormant',
    configured,
    subject: config.vapidSubject,
    hasStoredPair: (await readValue(KEY_PUBLIC)) !== null && priv.status !== 'absent',
    sealed: priv.status === 'ok' ? priv.sealed : false,
    kekAvailable: await kekAvailable(),
    envPinned: config.pins.vapid,
  };
}
