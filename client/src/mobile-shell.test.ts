import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract tests for the hand-maintained joins in `mobile/`: settings that live in native
 * project files and Capacitor configs, that nothing type-checks, and that a regenerated
 * project (`cap sync`, an Xcode "upgrade to recommended settings", `cap migrate`) can quietly
 * put back. Each one is a decision this repo made on purpose; the reason is next to it.
 */

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), 'utf8');

/**
 * The oldest platforms the client bundle can run on. Vite 8's default build target is
 * Chrome 111 / Safari 16.4, and Tailwind 4's CSS (cascade layers, `@property`, `color-mix`,
 * `oklch`) needs the same. Raise these when the build target rises; lowering them would let
 * the app install on a phone that cannot read its stylesheet.
 */
const FLOOR = { ios: [16, 4], webview: 111 } as const;

const versionOf = (v: string) => v.split('.').map(Number);
function atLeast(actual: string, floor: readonly number[]): boolean {
  const a = versionOf(actual);
  for (let i = 0; i < floor.length; i++) {
    if ((a[i] ?? 0) !== floor[i]) return (a[i] ?? 0) > floor[i]!;
  }
  return true;
}

describe('iOS', () => {
  const pbxproj = read('mobile', 'ios', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  const infoPlist = read('mobile', 'ios', 'ios', 'App', 'App', 'Info.plist');

  it('every build configuration targets an iOS the bundle can run on', () => {
    const targets = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1]!);
    expect(targets).toHaveLength(4); // project and target, Debug and Release
    for (const target of targets) expect(atLeast(target, FLOOR.ios), target).toBe(true);
  });

  it('ships a privacy manifest in the app target, and says it tracks nothing', () => {
    const path = join(repo, 'mobile', 'ios', 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy');
    expect(existsSync(path)).toBe(true);
    // A file that is on disk but not in the Resources phase is not in the app, so check the phase itself.
    const resources = pbxproj.split('/* Begin PBXResourcesBuildPhase section */')[1]?.split('/* End PBXResourcesBuildPhase section */')[0];
    expect(resources).toMatch(/PrivacyInfo\.xcprivacy in Resources/);
    const group = pbxproj.split('/* Begin PBXGroup section */')[1]?.split('/* End PBXGroup section */')[0];
    expect(group).toMatch(/PrivacyInfo\.xcprivacy/);

    const manifest = readFileSync(path, 'utf8');
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    expect(manifest).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
  });

  it('declares no collected data and no required-reason API, which the build scan supports', () => {
    const manifest = readFileSync(join(repo, 'mobile', 'ios', 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy'), 'utf8');
    expect(manifest).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
    expect(manifest).toMatch(/<key>NSPrivacyAccessedAPITypes<\/key>\s*<array\/>/);
  });

  it('answers the export-compliance question, so TestFlight does not ask on every upload', () => {
    expect(infoPlist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });

  it('does not turn App Transport Security off, only relaxes it for the local network', () => {
    expect(infoPlist).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
    expect(infoPlist).not.toMatch(/NSAllowsArbitraryLoads<\/key>\s*<true\/>/);
  });
});

describe('Android', () => {
  it('names a WebView floor the bundle can run on, and a page to show below it', async () => {
    const { default: config } = await import('../../mobile/android/capacitor.config.ts');
    expect(config.android?.minWebViewVersion ?? 0).toBeGreaterThanOrEqual(FLOOR.webview);

    // Below the floor Capacitor only writes to Logcat and loads the app anyway, unless an
    // errorPath is set, so the number alone protects nobody.
    const errorPath = config.server?.errorPath;
    expect(errorPath).toBeTruthy();
    expect(existsSync(join(repo, 'client', 'public', errorPath!))).toBe(true);
  });

  it('never allows mixed content: nothing in the page loads http, and live updates poll over native HTTP', async () => {
    const { default: config } = await import('../../mobile/android/capacitor.config.ts');
    expect(config.android?.allowMixedContent).toBeUndefined();
  });

  it('sends fetch through native HTTP, which is what keeps the session cookie and skips CORS', async () => {
    for (const platform of ['ios', 'android'] as const) {
      const { default: config } = await import(`../../mobile/${platform}/capacitor.config.ts`);
      expect(config.plugins?.CapacitorHttp?.enabled, platform).toBe(true);
    }
  });

  it('the page it falls back to needs nothing the old WebView lacks', () => {
    const page = read('client', 'public', 'cannot-start.html');
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/<link[^>]+stylesheet/i);
    expect(page).not.toMatch(/(oklch|color-mix|@layer|@property)/);
  });

  it('does not back the app up, so the sign-in session is not restored onto another device', () => {
    expect(read('mobile', 'android', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')).toMatch(
      /android:allowBackup="false"/,
    );
  });

  it('takes its build number and name from the build, not from the file', () => {
    const gradle = read('mobile', 'android', 'android', 'app', 'build.gradle');
    expect(gradle).toMatch(/findProperty\('appVersionCode'\)/);
    expect(gradle).toMatch(/findProperty\('appVersionName'\)/);
  });
});

describe('native dependencies', () => {
  it('adds no Capacitor plugin without a new privacy review', () => {
    // The privacy manifests declare nothing because there are no plugins. A plugin brings its own
    // data types and required-reason APIs, so adding one must start by re-running the build scan
    // that the manifest describes.
    const core = new Set(['@capacitor/core', '@capacitor/android', '@capacitor/ios', '@capacitor/cli']);
    for (const platform of ['ios', 'android'] as const) {
      const pkg = JSON.parse(read('mobile', platform, 'package.json'));
      const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      expect(names.filter((n) => n.startsWith('@capacitor/') && !core.has(n)), platform).toEqual([]);
    }
  });
});

describe('the bundle the apps load', () => {
  it('is the build:mobile output that both native projects point at', async () => {
    const script = JSON.parse(read('client', 'package.json')).scripts['build:mobile'] as string;
    expect(script).toContain('--outDir dist');
    for (const platform of ['ios', 'android'] as const) {
      const { default: config } = await import(`../../mobile/${platform}/capacitor.config.ts`);
      expect(join(repo, 'mobile', platform, config.webDir), platform).toBe(join(repo, 'client', 'dist'));
    }
  });

  it('loads no font from a third-party host, because the shells cannot be told to stop a request', () => {
    expect(read('client', 'index.html')).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('gives the web app and its install the same colour', () => {
    const manifest = JSON.parse(read('client', 'public', 'manifest.webmanifest'));
    expect(read('client', 'index.html')).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
    expect(manifest.background_color).toBe(manifest.theme_color);
  });
});
