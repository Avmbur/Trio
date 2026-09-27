import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {hash} from './snapshots';

export interface DirtyDocument {path: string; text: string}
export interface DirtyCopy {path: string; copy: string; created: boolean}
export interface DirtyCopies {copies: DirtyCopy[]; unchanged: string[]; failed: {path: string; error: string}[]}

// There is no reliable base revision for a restored dirty editor. A difference
// may be an unsaved edit OR an obsolete buffer left behind after a CLI write.
// Preserve the buffer separately; never pick a winner by overwriting the source.
export async function preserveDirty(files: DirtyDocument[], directory: string): Promise<DirtyCopies> {
  const result: DirtyCopies = {copies: [], unchanged: [], failed: []};
  for (const file of files) {
    try {
      const data = Buffer.from(file.text, 'utf8');
      let disk: Buffer | undefined;
      try {disk = await fs.readFile(file.path);} catch { /* Preserve even if the source is gone or unreadable. */ }
      if (disk?.equals(data)) {result.unchanged.push(file.path); continue;}
      const source = path.resolve(file.path);
      const key = hash(Buffer.concat([Buffer.from(source + '\0', 'utf8'), data]));
      const name = Array.from(path.parse(source).name).slice(0,80).join('') + '-' + key.slice(0,16);
      const copy = path.join(directory, name + (path.extname(source) || '.txt'));
      if (path.resolve(copy).toLowerCase() === source.toLowerCase()) throw new Error('Путь копии совпадает с исходным файлом.');
      await fs.mkdir(directory, {recursive: true});
      const metadata = path.join(directory, name + '.source.json');
      try {
        await fs.writeFile(metadata, JSON.stringify({source, encoding: 'utf8', savedAt: new Date().toISOString()}, null, 2), {flag: 'wx'});
      } catch (e) {if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;}
      let created = true;
      try {await fs.writeFile(copy, data, {flag: 'wx'});}
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // A repeated turn reuses its copy; a manually changed copy is not replaced.
        const stat = await fs.lstat(copy);
        if (!stat.isFile() || !(await fs.readFile(copy)).equals(data)) throw new Error('Существующая копия изменена: ' + copy);
        created = false;
      }
      result.copies.push({path: file.path, copy, created});
    } catch (e) {result.failed.push({path: file.path, error: String(e)});}
  }
  return result;
}
