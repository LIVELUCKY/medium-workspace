import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

// Opens a native macOS folder chooser (server-side, since this is a local tool)
// and returns the absolute path. Browsers cannot expose absolute paths from
// <input webkitdirectory>, so this is the only reliable native picker.
export async function POST() {
  try {
    // Activate Finder first — macOS Sequoia requires a frontmost app context
    // for `choose folder` dialogs spawned from background processes.
    const script = `
tell application "Finder" to activate
set theFolder to choose folder with prompt "Select your articles folder"
return POSIX path of theFolder
`.trim();
    const { stdout } = await exec('osascript', ['-e', script]);
    let dir = stdout.trim();
    if (!dir) return NextResponse.json({ error: 'No folder selected' }, { status: 400 });
    // osascript returns a trailing slash; strip it for consistent path handling
    if (dir.length > 1 && dir.endsWith('/')) dir = dir.slice(0, -1);
    return NextResponse.json({ path: dir });
  } catch (err) {
    // -128 = user canceled the dialog; anything else = osascript unavailable
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('-128')) return NextResponse.json({ error: 'canceled' }, { status: 400 });
    return NextResponse.json({ error: 'unavailable' }, { status: 500 });
  }
}
