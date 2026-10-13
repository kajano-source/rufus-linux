'use strict';

/**
 * Write an ISO image to a USB device.
 *
 * The whole pipeline (unmount -> partition -> dd -> sync) runs inside a single
 * `pkexec` transaction, so the polkit agent asks for the password exactly once
 * per flash instead of once per command.
 */

const fs = require('fs');

const { shellQuote, assertWritableDevice } = require('./shell');
const { runPrivileged, cancelPrivileged } = require('./privilege');

/**
 * Build the privileged script for a plain ISO write.
 * Kept pure and exported so it can be unit tested without root.
 */
function buildWriteScript({ isoPath, devicePath, partitionScheme }) {
  const label = partitionScheme === 'GPT' ? 'gpt' : 'msdos';

  return `
DEVICE=${shellQuote(devicePath)}
ISO=${shellQuote(isoPath)}

require_tools dd parted lsblk stat sync
[ -f "$ISO" ] || fail "ISO file not found: $ISO"
[ -b "$DEVICE" ] || fail "USB device is not present: $DEVICE"

PROGRESS_LOG="$RUFUS_TMP/progress.log"
: > "$PROGRESS_LOG"

cleanup() { unmount_device "$DEVICE"; }
trap cleanup EXIT

emit '{"stage":"unmounting","message":"Unmounting partitions...","percent":0}'
cancelled && exit 130
unmount_device "$DEVICE"

if [ -n ${shellQuote(partitionScheme || '')} ]; then
  emit '{"stage":"partitioning","message":"Creating partition table...","percent":2}'
  cancelled && exit 130
  parted -s "$DEVICE" mklabel ${shellQuote(label)} >>"$RUFUS_TMP/output.log" 2>&1 \\
    || fail "Could not create the ${partitionScheme} partition table on $DEVICE"
fi

emit '{"stage":"writing","message":"Writing ISO image...","percent":5}'
cancelled && exit 130

ISO_SIZE=$(stat -c %s "$ISO" 2>/dev/null || echo 0)
[ "$ISO_SIZE" -gt 0 ] || fail "Could not determine the size of $ISO"

run_with_progress "$PROGRESS_LOG" "$ISO_SIZE" \\
  dd if="$ISO" of="$DEVICE" bs=4M iflag=fullblock conv=fsync status=progress
code=$?
[ "$code" -eq 0 ] || fail "Writing the image to $DEVICE failed (dd exit code $code)"

emit '{"stage":"syncing","message":"Syncing...","percent":99}'
cancelled && exit 130
sync

emit '{"stage":"complete","message":"READY","percent":100}'
exit 0
`;
}

function writeIso(options, onProgress) {
  const { isoPath, devicePath, partitionScheme } = options;

  if (!isoPath || !devicePath) {
    return Promise.reject(new Error('ISO path and device path are required'));
  }
  if (!fs.existsSync(isoPath)) {
    return Promise.reject(new Error(`ISO file not found: ${isoPath}`));
  }
  assertWritableDevice(devicePath, 'write to');

  return runPrivileged({
    body: buildWriteScript({ isoPath, devicePath, partitionScheme }),
    onProgress
  });
}

/**
 * Cancel the running write. The privileged script owns the root processes, so
 * we ask it to stop through the shared cancel flag.
 */
function cancelWrite() {
  return cancelPrivileged();
}

module.exports = { writeIso, cancelWrite, buildWriteScript };
