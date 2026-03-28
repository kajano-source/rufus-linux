const crypto = require('crypto');
const fs = require('fs');

/**
 * Calculate MD5, SHA1, and SHA256 hashes for a file
 * Uses streams for large file support with progress reporting
 */
function calculateHashes(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }

    const fileSize = fs.statSync(filePath).size;
    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    const sha256 = crypto.createHash('sha256');

    let bytesRead = 0;

    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => {
      md5.update(chunk);
      sha1.update(chunk);
      sha256.update(chunk);
      bytesRead += chunk.length;

      const percent = Math.round((bytesRead / fileSize) * 100);
      if (onProgress) {
        onProgress({ percent, bytesRead, fileSize });
      }
    });

    stream.on('end', () => {
      resolve({
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex'),
        sha256: sha256.digest('hex'),
        sha512: 'Use <Alt>-<H> (in the main application window) to enable.'
      });
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

module.exports = { calculateHashes };
