import fs from 'fs';
import path from 'path';

/**
 * Writes through a sibling temp file and renames, so a crash cannot leave a
 * half-written store behind. The temp file never survives a successful write.
 */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    } catch {
      // Ignore cleanup failure; the original file is untouched.
    }
    throw err;
  }
}
