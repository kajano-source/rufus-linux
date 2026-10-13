'use strict';

/**
 * Format a USB drive as a plain (non-bootable) volume.
 *
 * Like the ISO writer, every privileged step runs in one `pkexec`
 * transaction: unmount, wipe, partition, format and label.
 */

const { shellQuote, assertWritableDevice } = require('./shell');
const { runPrivileged } = require('./privilege');

/**
 * Map the UI filesystem selection to a concrete mkfs invocation.
 * Returned as a shell command string so the whole thing can run privileged.
 */
function formatCommandFor(fileSystem, label, partDev, quickFormat) {
  const name = shellQuote(label);
  switch ((fileSystem || 'FAT32').toUpperCase()) {
    case 'FAT32':
    case 'FAT32 (DEFAULT)':
    case 'LARGE FAT32':
      return `mkfs.vfat -F 32 -n ${name} ${partDev}`;
    case 'NTFS':
      return quickFormat === false
        ? `mkfs.ntfs -L ${name} ${partDev}`
        : `mkfs.ntfs -f -L ${name} ${partDev}`;
    case 'EXFAT':
      return `mkfs.exfat -n ${name} ${partDev}`;
    case 'EXT4':
      return `mkfs.ext4 -L ${name} ${partDev}`;
    case 'EXT2':
      return `mkfs.ext2 -L ${name} ${partDev}`;
    default:
      return `mkfs.vfat -F 32 -n ${name} ${partDev}`;
  }
}

function buildFormatScript({ devicePath, partitionScheme, fileSystem, volumeLabel, quickFormat }) {
  const label = (volumeLabel || 'USB_DRIVE').toUpperCase();
  const ptType = partitionScheme === 'GPT' ? 'gpt' : 'msdos';
  const formatCmd = formatCommandFor(fileSystem, label, '$PART_DEV', quickFormat !== false);
  const requestedFs = (fileSystem || 'FAT32').toUpperCase();
  // mkfs.vfat refuses volumes above ~32 GiB; Rufus solves that by splitting the
  // drive into several FAT32 volumes, which this replica does not do yet. Say
  // so plainly instead of failing with a raw mkfs error.
  const fat32Guard = requestedFs.includes('FAT32') ? `
PART_BYTES=$(blockdev --getsize64 "$PART_DEV" 2>/dev/null || echo 0)
if [ "$PART_BYTES" -gt 34359738368 ] 2>/dev/null; then
  fail "FAT32 cannot hold more than 32 GB in a single volume. Pick exFAT, NTFS or ext4 for this drive."
fi` : '';

  return `
DEVICE=${shellQuote(devicePath)}

require_tools parted lsblk mkfs.vfat stat sync
[ -b "$DEVICE" ] || fail "USB device is not present: $DEVICE"

cleanup() { unmount_device "$DEVICE"; }
trap cleanup EXIT

emit '{"stage":"unmounting","message":"Unmounting partitions...","percent":5}'
cancelled && exit 130
unmount_device "$DEVICE"

emit '{"stage":"wiping","message":"Wiping partition table...","percent":15}'
cancelled && exit 130
wipefs --all --force "$DEVICE" >>"$RUFUS_TMP/output.log" 2>&1 || true
dd if=/dev/zero of="$DEVICE" bs=1M count=8 conv=fsync status=none >>"$RUFUS_TMP/output.log" 2>&1 || true

emit '{"stage":"partitioning","message":"Creating partition table...","percent":30}'
cancelled && exit 130
parted -s "$DEVICE" mklabel ${shellQuote(ptType)} >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Failed to create a ${partitionScheme} partition table on $DEVICE"
parted -s "$DEVICE" mkpart primary 1MiB 100% >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Failed to create the data partition on $DEVICE"

PART_DEV=$(part_dev "$DEVICE" 1)
wait_for_partition "$PART_DEV" || fail "The new partition $PART_DEV did not appear. Try re-plugging the drive."
${fat32Guard}

emit '{"stage":"formatting","message":"Formatting...","percent":70}'
cancelled && exit 130
${formatCmd} >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Failed to format $PART_DEV as ${fileSystem || 'FAT32'}"

sync
emit '{"stage":"complete","message":"READY","percent":100}'
exit 0
`;
}

async function formatDrive(options, onProgress) {
  const { devicePath } = options;
  if (!devicePath) {
    throw new Error('Device path is required');
  }
  assertWritableDevice(devicePath, 'format');

  await runPrivileged({
    body: buildFormatScript(options),
    onProgress
  });
}

module.exports = { formatDrive, buildFormatScript, formatCommandFor };
