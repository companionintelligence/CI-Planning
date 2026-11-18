import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { apiUrl } from './server-config.js';

/** Write an export into the app cache and hand it to the platform share/save sheet. */
export async function shareTextExport(filename: string, content: string, title: string): Promise<void> {
  // A unique folder lets two quick exports of the same named item coexist while the
  // share chooser is open, and keeps the exported basename readable in destination apps.
  const folder = `exports/${crypto.randomUUID()}`;
  const basename = filename.split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]/g, '_') || 'companion-export.dat';
  const path = `${folder}/${basename}`;
  try {
    const { uri } = await Filesystem.writeFile({
      path,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    await Share.share({ title, dialogTitle: title, files: [uri] });
  } finally {
    // The OS share sheet has finished (or was dismissed), so remove the temporary copy.
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
    await Filesystem.rmdir({ path: folder, directory: Directory.Cache }).catch(() => {});
  }
}

/** Fetch a server-generated export through the configured API, then share it as a file. */
export async function shareApiExport(path: string, filename: string, title: string): Promise<void> {
  const response = await fetch(apiUrl(path), { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  await shareTextExport(filename, await response.text(), title);
}
