const { execSync } = require('child_process');

/**
 * Create partition table on a device
 */
function createPartitionTable(devicePath, scheme) {
  const label = scheme === 'GPT' ? 'gpt' : 'msdos';
  execSync(`pkexec parted -s ${devicePath} mklabel ${label}`);
}

/**
 * Create a single partition spanning the entire disk
 */
function createPartition(devicePath, fsType) {
  execSync(`pkexec parted -s ${devicePath} mkpart primary 1MiB 100%`);
  execSync(`pkexec partprobe ${devicePath}`);
}

/**
 * Get partition info for a device
 */
function getPartitions(devicePath) {
  try {
    const output = execSync(`lsblk -n -o NAME,SIZE,FSTYPE,LABEL ${devicePath}`).toString().trim();
    return output.split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        name: parts[0] || '',
        size: parts[1] || '',
        fstype: parts[2] || '',
        label: parts[3] || ''
      };
    });
  } catch (e) {
    return [];
  }
}

module.exports = { createPartitionTable, createPartition, getPartitions };
