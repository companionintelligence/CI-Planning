import { isCapacitorShell } from './server-config.js';

const LOCK_KEY = 'device-app-lock';
const STORAGE_PREFIX = 'ci-planning-device-lock';
const PBKDF2_ITERATIONS = 310_000;
export const DEVICE_LOCK_CHANGED_EVENT = 'device-app-lock:changed';

export interface LockVerifier { salt: string; hash: string; iterations: number }

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function secureStorage() {
  if (!isCapacitorShell()) throw new Error('Device app lock is available only in the mobile app');
  const { SecureStorage, KeychainAccess } = await import('@aparajita/capacitor-secure-storage');
  await SecureStorage.setKeyPrefix(STORAGE_PREFIX);
  await SecureStorage.setSynchronize(false);
  return { SecureStorage, KeychainAccess };
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBuffer, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

export async function getDeviceLockVerifier(): Promise<LockVerifier | null> {
  const { SecureStorage } = await secureStorage();
  const value = await SecureStorage.get(LOCK_KEY, false, false);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<LockVerifier>;
  if (typeof record.salt !== 'string' || typeof record.hash !== 'string'
    || !Number.isInteger(record.iterations) || (record.iterations ?? 0) < 100_000 || (record.iterations ?? 0) > 1_000_000) {
    throw new Error('The saved device lock is invalid');
  }
  return { salt: record.salt, hash: record.hash, iterations: record.iterations! };
}

export async function hasDeviceLock(): Promise<boolean> {
  return (await getDeviceLockVerifier()) !== null;
}

export async function setDeviceLockPassword(password: string): Promise<void> {
  if (password.length < 8) throw new Error('Use at least 8 characters');
  if (password.length > 256) throw new Error('App password must be 256 characters or fewer');
  const { SecureStorage, KeychainAccess } = await secureStorage();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  await SecureStorage.set(LOCK_KEY, { salt: encode(salt), hash: encode(hash), iterations: PBKDF2_ITERATIONS }, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DEVICE_LOCK_CHANGED_EVENT));
}

export async function verifyDeviceLockPassword(password: string, verifier: LockVerifier): Promise<boolean> {
  const expected = decode(verifier.hash);
  const actual = await derive(password, decode(verifier.salt), verifier.iterations);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i]! ^ expected[i]!;
  return difference === 0;
}

export async function clearDeviceLock(): Promise<void> {
  const { SecureStorage } = await secureStorage();
  await SecureStorage.remove(LOCK_KEY, false);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DEVICE_LOCK_CHANGED_EVENT));
}
