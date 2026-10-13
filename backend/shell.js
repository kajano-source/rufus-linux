'use strict';

/**
 * Small helpers shared by the backend modules: safe shell quoting, command
 * execution and the device-path guards that keep Rufus from touching anything
 * that is not a removable drive.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OS_TOOLS = [
  'pkexec',
  'lsblk',
  'parted',
  'mkfs.vfat',
  'mkfs.ntfs',
  'mount',
  'umount',
  'wipefs',
  'sync',
  'sfdisk',
  'blockdev',
  'dd'
];

/**
 * Quote a value so that it can be safely embedded in a generated bash script.
 * Everything goes through single quotes, which neutralise every shell
 * metacharacter. Embedded single quotes are closed, escaped and reopened.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a command without a shell and resolve with the result instead of
 * throwing. Never rejects: callers inspect `code` themselves.
 */
function run(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, ...(options.env || {}) }
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error || null
      });
    });
  });
}

function which(tool) {
  const dirs = (process.env.PATH || '/usr/bin:/bin').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (e) {
      // keep looking
    }
  }
  return null;
}

/**
 * Report which helper programs are missing so the UI can tell the user what to
 * install before a privileged operation starts (instead of failing halfway
 * through a flash).
 */
function checkTools(required = OS_TOOLS) {
  const missing = [];
  const found = {};
  for (const tool of required) {
    const path = which(tool);
    found[tool] = path;
    if (!path) missing.push(tool);
  }
  return { found, missing };
}

/**
 * Only whole-disk removable device nodes may be written to. Partition device
 * nodes are rejected so a stray UI value can never turn into "format a disk".
 */
function isWritableDevice(devicePath) {
  return typeof devicePath === 'string' &&
    /^\/dev\/(sd[a-z]+|mmcblk\d+|nvme\d+n\d+)$/.test(devicePath);
}

function assertWritableDevice(devicePath, action = 'write to') {
  if (!isWritableDevice(devicePath)) {
    throw new Error(`Refusing to ${action} a non-removable device: ${devicePath}`);
  }
}

/**
 * /dev/sdb -> /dev/sdb1, /dev/nvme0n1 -> /dev/nvme0n1p1
 */
function partitionPath(devicePath, index) {
  if (/\/(nvme\d+n\d+|mmcblk\d+)$/.test(devicePath)) {
    return `${devicePath}p${index}`;
  }
  return `${devicePath}${index}`;
}

/**
 * Device size in bytes, or 0 when it cannot be determined.
 */
async function deviceSizeBytes(devicePath) {
  const result = await run('lsblk', ['-bdn', '-o', 'SIZE', devicePath]);
  if (result.code !== 0) return 0;
  const value = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Human readable byte count, used for UI messages.
 */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / Math.pow(1024, exponent);
  return `${exponent === 0 ? scaled : scaled.toFixed(1)} ${units[exponent]}`;
}

module.exports = {
  shellQuote,
  run,
  which,
  checkTools,
  isWritableDevice,
  assertWritableDevice,
  partitionPath,
  deviceSizeBytes,
  formatBytes,
  spawn
};
