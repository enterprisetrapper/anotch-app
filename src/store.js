const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createStore(directory, encryption) {
  let queue = Promise.resolve();
  const cells = new Map();
  function file(name) { return path.join(directory, name + '.enc'); }
  function serial(work) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }

  return {
    read(name, fallback) {
      return serial(async () => {
        if (cells.has(name)) return cells.get(name);
        try {
          const bytes = await fs.readFile(file(name));
          const decrypted = await encryption.decryptStringAsync(bytes);
          const value = JSON.parse(decrypted.result);
          cells.set(name, value);
          return value;
        } catch (error) {
          if (error.code === 'ENOENT') return fallback;
          throw new Error('Anotch could not unlock the saved data. Unlock your macOS Keychain and reopen Anotch.');
        }
      });
    },
    write(name, value) {
      return serial(async () => {
        if (!await encryption.isAsyncEncryptionAvailable()) {
          throw new Error('macOS Keychain is unavailable. Nothing was saved to disk.');
        }
        const bytes = await encryption.encryptStringAsync(JSON.stringify(value));
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const pending = file(name) + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(pending, bytes, { flag: 'wx', mode: 0o600 });
          await fs.rename(pending, file(name));
          cells.set(name, value);
        } finally {
          await fs.unlink(pending).catch(() => {});
        }
      });
    },
    remove(name) {
      return serial(async () => {
        await fs.unlink(file(name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        cells.delete(name);
      });
    },
    drain: () => queue
  };
}

module.exports = { createStore };
