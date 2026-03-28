const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let currentProcess = null;
let cancelled = false;

/**
 * Write an ISO image to a USB device using dd via pkexec
 */
function writeIso(options, onProgress) {
  return new Promise((resolve, reject) => {
    const { isoPath, devicePath, partitionScheme } = options;
    cancelled = false;

    if (!isoPath || !devicePath) {
      return reject(new Error('ISO path and device path are required'));
    }

    if (!fs.existsSync(isoPath)) {
      return reject(new Error(`ISO file not found: ${isoPath}`));
    }

    // Safety check - make sure we're writing to a removable device
    if (!devicePath.startsWith('/dev/sd') && !devicePath.startsWith('/dev/mmcblk')) {
      return reject(new Error(`Refusing to write to non-removable device: ${devicePath}`));
    }

    const isoSize = fs.statSync(isoPath).size;

    // Step 1: Unmount all partitions
    onProgress({ stage: 'unmounting', message: 'Unmounting partitions...', percent: 0 });

    try {
      // Get all mounted partitions for this device
      const partitions = execSync(`lsblk -n -o NAME,MOUNTPOINT ${devicePath} 2>/dev/null || true`).toString().trim().split('\n');
      for (const line of partitions) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1]) {
          try {
            execSync(`pkexec umount ${parts[1]} 2>/dev/null || true`);
          } catch (e) {
            // ignore unmount errors
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // Step 2: Optionally set partition table
    if (partitionScheme) {
      onProgress({ stage: 'partitioning', message: 'Creating partition table...', percent: 2 });
      try {
        const label = partitionScheme === 'GPT' ? 'gpt' : 'msdos';
        execSync(`pkexec parted -s ${devicePath} mklabel ${label} 2>/dev/null || true`);
      } catch (e) {
        // Continue even if partitioning fails
      }
    }

    // Step 3: Write ISO with dd
    onProgress({ stage: 'writing', message: 'Writing ISO image...', percent: 5 });

    // Create a shell script to run dd and report progress
    const scriptContent = `#!/bin/bash
dd if="${isoPath}" of="${devicePath}" bs=4M conv=fsync status=progress 2>&1
sync
echo "DD_COMPLETE"
`;
    const scriptPath = '/tmp/rufus-linux-dd.sh';
    fs.writeFileSync(scriptPath, scriptContent);
    fs.chmodSync(scriptPath, '755');

    currentProcess = spawn('pkexec', ['bash', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let lastPercent = 5;

    const parseProgress = (data) => {
      const text = data.toString();
      // dd outputs progress like: "123456789 bytes (123 MB, 118 MiB) copied, 1.23 s, 100 MB/s"
      const match = text.match(/(\d+)\s+bytes/);
      if (match) {
        const bytesWritten = parseInt(match[1]);
        const percent = Math.min(99, Math.round((bytesWritten / isoSize) * 100));
        if (percent > lastPercent) {
          lastPercent = percent;
          const mbWritten = (bytesWritten / (1024 * 1024)).toFixed(1);
          const mbTotal = (isoSize / (1024 * 1024)).toFixed(1);
          onProgress({
            stage: 'writing',
            message: `Copying ISO files: ${percent}.0%`,
            percent: percent,
            detail: `${mbWritten} MB / ${mbTotal} MB`
          });
        }
      }
      if (text.includes('DD_COMPLETE')) {
        onProgress({ stage: 'syncing', message: 'Syncing...', percent: 99 });
      }
    };

    currentProcess.stdout.on('data', parseProgress);
    currentProcess.stderr.on('data', parseProgress);

    currentProcess.on('close', (code) => {
      currentProcess = null;
      // Clean up script
      try { fs.unlinkSync(scriptPath); } catch(e) {}

      if (cancelled) {
        onProgress({ stage: 'cancelled', message: 'Cancelled', percent: 0 });
        reject(new Error('Operation cancelled'));
        return;
      }

      if (code === 0) {
        onProgress({ stage: 'complete', message: 'READY', percent: 100 });
        resolve();
      } else if (code === 126 || code === 127) {
        reject(new Error('Authorization denied or pkexec not found'));
      } else {
        reject(new Error(`dd process exited with code ${code}`));
      }
    });

    currentProcess.on('error', (err) => {
      currentProcess = null;
      reject(err);
    });
  });
}

/**
 * Cancel the current write operation
 */
function cancelWrite() {
  cancelled = true;
  if (currentProcess) {
    try {
      // Kill the pkexec process tree
      execSync(`pkexec kill -9 ${currentProcess.pid} 2>/dev/null || true`);
      currentProcess.kill('SIGKILL');
    } catch (e) {
      // try regular kill
      try { currentProcess.kill('SIGTERM'); } catch(e2) {}
    }
    currentProcess = null;
  }
}

module.exports = { writeIso, cancelWrite };
