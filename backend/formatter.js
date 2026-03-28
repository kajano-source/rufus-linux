const { execSync } = require('child_process');
const fs = require('fs');

/**
 * Format a USB drive as non-bootable (normal storage)
 * This creates a clean partition table + single data partition + filesystem
 */
async function formatDrive(options, onProgress) {
  const { devicePath, partitionScheme, fileSystem, volumeLabel, quickFormat } = options;

  if (!devicePath) {
    throw new Error('Device path is required');
  }

  // Safety check
  if (!devicePath.startsWith('/dev/sd') && !devicePath.startsWith('/dev/mmcblk')) {
    throw new Error(`Refusing to format non-removable device: ${devicePath}`);
  }

  const steps = [
    { stage: 'unmounting', message: 'Unmounting partitions...', percent: 5 },
    { stage: 'wiping', message: 'Wiping partition table...', percent: 15 },
    { stage: 'partitioning', message: 'Creating partition table...', percent: 30 },
    { stage: 'creating', message: 'Creating partition...', percent: 50 },
    { stage: 'formatting', message: 'Formatting...', percent: 70 },
    { stage: 'labeling', message: 'Setting volume label...', percent: 90 },
    { stage: 'complete', message: 'READY', percent: 100 }
  ];

  // Step 1: Unmount
  onProgress(steps[0]);
  try {
    execSync(`pkexec bash -c 'umount ${devicePath}* 2>/dev/null; true'`);
  } catch (e) { /* ignore */ }

  // Step 2: Wipe existing partition table
  onProgress(steps[1]);
  try {
    execSync(`pkexec dd if=/dev/zero of=${devicePath} bs=512 count=2048 2>/dev/null`);
  } catch (e) { /* ignore */ }

  // Step 3: Create partition table
  onProgress(steps[2]);
  const ptType = (partitionScheme || 'MBR') === 'GPT' ? 'gpt' : 'msdos';
  try {
    execSync(`pkexec parted -s ${devicePath} mklabel ${ptType}`);
  } catch (e) {
    throw new Error(`Failed to create partition table: ${e.message}`);
  }

  // Step 4: Create single partition spanning full disk
  onProgress(steps[3]);
  try {
    if (ptType === 'gpt') {
      execSync(`pkexec parted -s ${devicePath} mkpart primary 1MiB 100%`);
    } else {
      execSync(`pkexec parted -s ${devicePath} mkpart primary 1MiB 100%`);
    }
  } catch (e) {
    throw new Error(`Failed to create partition: ${e.message}`);
  }

  // Wait for kernel to re-read partition table
  try {
    execSync(`pkexec partprobe ${devicePath}`);
  } catch (e) { /* ignore */ }
  
  // Small delay for partition to appear
  await new Promise(r => setTimeout(r, 1000));

  // Determine partition device name
  let partDev;
  if (devicePath.includes('mmcblk') || devicePath.includes('nvme')) {
    partDev = devicePath + 'p1';
  } else {
    partDev = devicePath + '1';
  }

  // Step 5: Format with chosen filesystem
  onProgress(steps[4]);
  const label = volumeLabel || 'USB_DRIVE';
  const fs_type = (fileSystem || 'FAT32').toUpperCase();

  try {
    let formatCmd;
    switch (fs_type) {
      case 'FAT32':
      case 'FAT32 (DEFAULT)':
        formatCmd = `pkexec mkfs.vfat -F 32 -n "${label}" ${partDev}`;
        break;
      case 'LARGE FAT32':
        formatCmd = `pkexec mkfs.vfat -F 32 -n "${label}" ${partDev}`;
        break;
      case 'NTFS':
        if (quickFormat !== false) {
          formatCmd = `pkexec mkfs.ntfs -f -L "${label}" ${partDev}`;
        } else {
          formatCmd = `pkexec mkfs.ntfs -L "${label}" ${partDev}`;
        }
        break;
      case 'EXFAT':
        formatCmd = `pkexec mkfs.exfat -n "${label}" ${partDev}`;
        break;
      case 'EXT4':
        formatCmd = `pkexec mkfs.ext4 -L "${label}" ${partDev}`;
        break;
      case 'EXT2':
        formatCmd = `pkexec mkfs.ext2 -L "${label}" ${partDev}`;
        break;
      default:
        formatCmd = `pkexec mkfs.vfat -F 32 -n "${label}" ${partDev}`;
    }
    execSync(formatCmd);
  } catch (e) {
    throw new Error(`Failed to format: ${e.message}`);
  }

  // Step 6: Done
  onProgress(steps[5]);
  onProgress(steps[6]);
}

module.exports = { formatDrive };
