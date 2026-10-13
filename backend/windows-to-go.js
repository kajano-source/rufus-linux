'use strict';

/**
 * Windows To Go creation.
 *
 * The "Windows To Go" image option used to be silently ignored: the renderer
 * never passed it to the backend, so the app performed a plain ISO dd and the
 * resulting stick was a Windows installer, not a portable Windows. Nothing
 * downstream of the UI had a Windows To Go code path at all.
 *
 * This module implements the real thing, the way Rufus does it on Linux:
 *
 *   1. mount the ISO read-only and inspect sources/install.wim
 *   2. pick the Enterprise/Education image - the only editions Microsoft allows
 *      to run from removable media - and check it fits on the stick
 *   3. partition the stick as GPT: a 260 MiB FAT32 EFI system partition plus one
 *      NTFS "Windows" partition
 *   4. apply the selected WIM image straight onto the NTFS volume
 *   5. build the EFI system partition from the image's own Microsoft-signed boot
 *      manager, plus a BCD that boots \WINDOWS\system32\winload.efi from it
 *   6. drop in a Windows To Go answer file so the first boot skips the OOBE
 *
 * The whole pipeline runs inside one pkexec transaction, so it costs one
 * password entry and produces no output at all when the media turns out to be
 * unusable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { shellQuote, assertWritableDevice, which, formatBytes } = require('./shell');
const { runPrivileged } = require('./privilege');
const bcd = require('./wtg-bcd');

const ESP_SIZE_MIB = 260;
const SPARE_BYTES = 128 * 1024 * 1024;
const SUPPORTED_EDITIONS = /(enterprise|education)/i;
const REQUIRED_TOOLS = [
  'parted', 'lsblk', 'mkfs.vfat', 'mkfs.ntfs', 'mount', 'umount', 'udevadm',
  'wipefs', 'wimlib-imagex', 'hivexsh'
];

/**
 * The Windows To Go answer file. There is deliberately no `windowsPE` pass:
 * Windows To Go runs the oobeSystem pass, and the WinPE-only keys would stop
 * the OOBE bypass from being applied.
 */
const UNATTEND_XML = `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64"
               publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
    </component>
  </settings>
</unattend>
`;

/**
 * Parse `wimlib-imagex info` output into
 * { images: [{ index, name, description, size }], architecture, wimSize }.
 */
function parseWimInfo(text) {
  const result = { images: [], architecture: '', wimSize: 0 };
  let current = null;

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const indexMatch = line.match(/^Index:\s*(\d+)/);
    if (indexMatch) {
      current = { index: parseInt(indexMatch[1], 10), name: '', description: '', size: 0 };
      result.images.push(current);
      continue;
    }
    const field = line.match(/^(Name|Description|Size|Architecture):\s*(.*)$/);
    if (!field) continue;
    const [, key, value] = field;
    if (key === 'Architecture' && !current) {
      result.architecture = value.trim();
      continue;
    }
    if (key === 'Size' && !current) {
      result.wimSize = parseInt(value, 10) || 0;
      continue;
    }
    if (!current) continue;
    if (key === 'Name') current.name = value.trim();
    else if (key === 'Description') current.description = value.trim();
    else if (key === 'Size') current.size = parseInt(value, 10) || 0;
  }

  return result;
}

/**
 * Choose the image Windows To Go supports, the same way Rufus does: only
 * Enterprise and Education images may boot from removable media.
 */
function selectWindowsToGoImage(images) {
  const supported = (images || []).filter((image) => SUPPORTED_EDITIONS.test(image.name || ''));
  return supported.length ? supported[0] : null;
}

function missingTools() {
  return REQUIRED_TOOLS.filter((tool) => !which(tool));
}

/**
 * The privileged script for the whole Windows To Go build.
 * Pure string generation so it can be unit tested without root.
 */
function buildWtgScript({ isoPath, devicePath, volumeLabel = 'WINDOWS TO GO', imageIndex, locale, description }) {
  const bcdWriter = bcd.buildBcdWriterBash({ locale, description });
  const label = String(volumeLabel || 'WINDOWS TO GO').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32);

  return `
require_tools ${REQUIRED_TOOLS.join(' ')}
${bcdWriter}

DEVICE=${shellQuote(devicePath)}
ISO=${shellQuote(isoPath)}
IMAGE_INDEX=${shellQuote(String(imageIndex))}
VOLUME_LABEL=${shellQuote(label)}
ISO_MOUNT="$RUFUS_TMP/iso"
ESP_MOUNT="$RUFUS_TMP/esp"
STAGE="$RUFUS_TMP/stage"
BCD_TEMPLATE="$STAGE/Windows/System32/config/BCD-Template"
BCD_OUT="$ESP_MOUNT/EFI/Microsoft/Boot/BCD"
WIM_LOG="$RUFUS_TMP/wim.log"

[ -f "$ISO" ] || fail "ISO file not found: $ISO"
[ -b "$DEVICE" ] || fail "USB device is not present: $DEVICE"

mkdir -p "$ISO_MOUNT" "$ESP_MOUNT" "$STAGE" || fail "Could not create working directories"

ESP_PART=""
cleanup() {
  umount "$ESP_MOUNT" >/dev/null 2>&1 || true
  umount "$ISO_MOUNT" >/dev/null 2>&1 || true
  rmdir "$ESP_MOUNT" "$ISO_MOUNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- inspect the media before anything is erased -----------------------------
emit '{"stage":"inspecting","message":"Reading Windows image...","percent":1}'
cancelled && exit 130

mount -o loop,ro,nosuid,nodev,noexec "$ISO" "$ISO_MOUNT" \\
  || fail "Could not mount the ISO image (is it a valid hybrid ISO?)"

WIM="$ISO_MOUNT/sources/install.wim"
if [ ! -f "$WIM" ]; then
  [ -f "$ISO_MOUNT/sources/install.swm" ] \\
    && fail "This ISO uses a split install.swm image, which this version cannot turn into Windows To Go media."
  fail "This ISO has no sources/install.wim, so it cannot be turned into Windows To Go media."
fi

wimlib-imagex info "$WIM" >"$WIM_LOG" 2>&1 \\
  || fail "wimlib could not read sources/install.wim from this ISO."
grep -Eq "^Index:[[:space:]]*$IMAGE_INDEX\\$" "$WIM_LOG" \\
  || fail "Image $IMAGE_INDEX is not present in this Windows image."
grep -Eqi "^Name:.*(Enterprise|Education)" "$WIM_LOG" \\
  || fail "Windows To Go requires a Windows Enterprise or Education image, which this ISO does not contain."

# --- partition ---------------------------------------------------------------
emit '{"stage":"unmounting","message":"Unmounting partitions...","percent":4}'
cancelled && exit 130
umount "$ISO_MOUNT" >/dev/null 2>&1 || umount -l "$ISO_MOUNT" >/dev/null 2>&1 || true
unmount_device "$DEVICE"

emit '{"stage":"partitioning","message":"Creating Windows To Go layout...","percent":6}'
cancelled && exit 130
wipefs --all --force "$DEVICE" >>"$RUFUS_TMP/output.log" 2>&1 || true
parted -s "$DEVICE" mklabel gpt >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Could not write a GPT partition table to $DEVICE"
parted -s "$DEVICE" mkpart "EFI system partition" fat32 1MiB ${ESP_SIZE_MIB + 1}MiB >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Could not create the EFI system partition."
parted -s "$DEVICE" set 1 esp on >>"$RUFUS_TMP/output.log" 2>&1 || true
parted -s "$DEVICE" mkpart "Windows" ntfs ${ESP_SIZE_MIB + 1}MiB 100% >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Could not create the Windows partition."
parted -s "$DEVICE" set 2 msftdata on >>"$RUFUS_TMP/output.log" 2>&1 || true

ESP_PART="$(part_dev "$DEVICE" 1)"
OS_PART="$(part_dev "$DEVICE" 2)"
wait_for_partition "$ESP_PART" || fail "The EFI system partition did not appear on $DEVICE."
wait_for_partition "$OS_PART" || fail "The Windows partition did not appear on $DEVICE."

DISK_GUID=$(lsblk -n -d -o PTUUID "$DEVICE" | tr -d '[:space:]')
ESP_GUID=$(lsblk -n -o PARTUUID "$ESP_PART" | tr -d '[:space:]')
OS_GUID=$(lsblk -n -o PARTUUID "$OS_PART" | tr -d '[:space:]')
[ -n "$DISK_GUID" ] && [ -n "$ESP_GUID" ] && [ -n "$OS_GUID" ] \\
  || fail "Could not read the GPT identifiers needed for the boot configuration."

# --- format ------------------------------------------------------------------
emit '{"stage":"formatting","message":"Formatting partitions...","percent":8}'
cancelled && exit 130
mkfs.vfat -F 32 -n "RUFUS-ESP" "$ESP_PART" >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Could not create the FAT32 EFI system partition."
mkfs.ntfs -f -L "$VOLUME_LABEL" "$OS_PART" >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Could not create the NTFS Windows partition."

# --- apply the Windows image -------------------------------------------------
emit '{"stage":"applying","message":"Applying Windows image...","percent":10}'
cancelled && exit 130
mount -o loop,ro,nosuid,nodev,noexec "$ISO" "$ISO_MOUNT" 2>/dev/null \\
  || fail "Could not re-mount the ISO image."

run_with_percent "$WIM_LOG" 10 72 \\
  wimlib-imagex apply "$ISO_MOUNT/sources/install.wim" "$IMAGE_INDEX" "$OS_PART" \\
    --no-acls --no-attributes
code=$?
[ "$code" -eq 0 ] || {
  tail -c 600 "$WIM_LOG" >>"$RUFUS_TMP/output.log" 2>/dev/null || true
  fail "Applying the Windows image to the USB drive failed (wimlib exit code $code)."
}

# --- stage the boot material that ships inside the image ---------------------
emit '{"stage":"applying","message":"Extracting boot files...","percent":84}'
cancelled && exit 130
wimlib-imagex extract "$ISO_MOUNT/sources/install.wim" "$IMAGE_INDEX" \\
  Windows/System32/config/BCD-Template Windows/Boot/EFI \\
  --dest-dir="$STAGE" --no-acls --no-attributes --no-globs \\
  >>"$RUFUS_TMP/output.log" 2>&1 || true

[ -f "$BCD_TEMPLATE" ] \\
  || fail "The Windows image does not contain a BCD-Template, so its boot configuration cannot be built."

# --- EFI system partition ----------------------------------------------------
emit '{"stage":"boot-config","message":"Creating boot configuration...","percent":88}'
cancelled && exit 130
mount -t vfat "$ESP_PART" "$ESP_MOUNT" >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Could not mount the EFI system partition."

mkdir -p "$ESP_MOUNT/EFI/Microsoft/Boot" \\
  || fail "Could not prepare the EFI system partition layout."

if [ -d "$STAGE/Windows/Boot/EFI" ]; then
  cp -a "$STAGE/Windows/Boot/EFI/." "$ESP_MOUNT/EFI/Microsoft/Boot/" >>"$RUFUS_TMP/output.log" 2>&1 || true
fi
[ -f "$ESP_MOUNT/EFI/Microsoft/Boot/bootmgfw.efi" ] \\
  || fail "The Windows image does not contain a signed boot manager (bootmgfw.efi)."
[ -d "$STAGE/Windows/Boot/Fonts" ] || wimlib-imagex extract "$ISO_MOUNT/sources/install.wim" "$IMAGE_INDEX" \\
  Windows/Boot/Fonts --dest-dir="$STAGE" --no-acls --no-attributes --no-globs \\
  >>"$RUFUS_TMP/output.log" 2>&1 || true
if [ -d "$STAGE/Windows/Boot/Fonts" ]; then
  mkdir -p "$ESP_MOUNT/EFI/Microsoft/Boot/Fonts"
  cp -a "$STAGE/Windows/Boot/Fonts/." "$ESP_MOUNT/EFI/Microsoft/Boot/Fonts/" 2>/dev/null || true
fi

# Removable-media fallback path for firmware that only reads \\EFI\\BOOT\\BOOTX64.EFI
mkdir -p "$ESP_MOUNT/EFI/Boot"
cp "$ESP_MOUNT/EFI/Microsoft/Boot/bootmgfw.efi" "$ESP_MOUNT/EFI/Boot/bootx64.efi" 2>/dev/null || true

emit_bcd_script "$RUFUS_TMP/BCD.hivex" || fail "Could not generate the boot configuration script."
hivexsh -w -f "$RUFUS_TMP/BCD.hivex" "$BCD_TEMPLATE" \\
  >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Building the Windows To Go boot configuration failed. See the log for hivex output."
[ -s "$BCD_OUT" ] || fail "The generated boot configuration is empty."

sync
umount "$ESP_MOUNT" >/dev/null 2>&1 || fail "Could not flush the EFI system partition."

# --- answer file -------------------------------------------------------------
emit '{"stage":"finalizing","message":"Configuring first boot...","percent":94}'
cancelled && exit 130
umount "$ISO_MOUNT" >/dev/null 2>&1 || true
mount -t ntfs "$OS_PART" "$ISO_MOUNT" >>"$RUFUS_TMP/output.log" 2>&1 \\
  || mount -t ntfs3 "$OS_PART" "$ISO_MOUNT" >>"$RUFUS_TMP/output.log" 2>&1 \\
  || fail "Could not mount the Windows partition to finalise the setup."
mkdir -p "$ISO_MOUNT/Windows/Panther"
printf '%s' "$RUFUS_UNATTEND" > "$ISO_MOUNT/Windows/Panther/Unattend.xml" \\
  || fail "Could not write the Windows To Go answer file."
sync
umount "$ISO_MOUNT" >/dev/null 2>&1 || fail "Could not flush the Windows partition."

sync
emit '{"stage":"complete","message":"READY","percent":100}'
exit 0
`;
}

/**
 * Inspect the ISO and report what would be installed. Needs root (loop mount),
 * so it is a privileged transaction of its own; polkit caches the authorisation
 * so this does not normally cost a second password prompt.
 */
async function inspectWindowsToGo(options) {
  const { isoPath, devicePath } = options;
  assertWritableDevice(devicePath, 'write to');

  const missing = missingTools();
  if (missing.length) {
    throw new Error(`Windows To Go needs these tools: ${missing.join(', ')}. Install them and try again.`);
  }

  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rufus-wtg-inspect-'));
  const script = `
require_tools mount umount lsblk wimlib-imagex
mkdir -p ${shellQuote(mountDir)}
mount -o loop,ro,nosuid,nodev,noexec ${shellQuote(isoPath)} ${shellQuote(mountDir)} || fail "Could not mount the ISO image."
wimlib-imagex info ${shellQuote(mountDir)}/sources/install.wim
code=$?
umount ${shellQuote(mountDir)} >/dev/null 2>&1 || umount -l ${shellQuote(mountDir)} >/dev/null 2>&1 || true
exit $code
`;

  let info;
  try {
    const result = await runPrivileged({ body: script, onProgress: () => {} });
    info = parseWimInfo(result.stdout);
  } finally {
    try {
      fs.rmdirSync(mountDir);
    } catch (e) {
      // best effort
    }
  }

  const image = selectWindowsToGoImage(info.images);
  if (!image) {
    const names = info.images.map((entry) => entry.name).filter(Boolean).join(', ') || 'none';
    throw new Error(`Windows To Go requires a Windows Enterprise or Education image. This ISO contains: ${names}.`);
  }

  const required = image.size + ESP_SIZE_MIB * 1024 * 1024 + SPARE_BYTES;
  if (options.targetSizeBytes && options.targetSizeBytes < required) {
    throw new Error(`${image.name} needs about ${formatBytes(required)} of space but the drive only has ${formatBytes(options.targetSizeBytes)}.`);
  }

  return {
    image,
    images: info.images,
    architecture: info.architecture,
    requiredBytes: required,
    availableImages: info.images.filter((entry) => SUPPORTED_EDITIONS.test(entry.name || ''))
  };
}

/**
 * Create the Windows To Go stick.
 */
async function createWindowsToGo(options, onProgress) {
  const { isoPath, devicePath, image, volumeLabel = 'WINDOWS TO GO' } = options;

  if (!isoPath || !devicePath) {
    throw new Error('ISO path and device path are required');
  }
  if (!fs.existsSync(isoPath)) {
    throw new Error(`ISO file not found: ${isoPath}`);
  }
  assertWritableDevice(devicePath, 'write to');

  const missing = missingTools();
  if (missing.length) {
    throw new Error(`Windows To Go needs these tools: ${missing.join(', ')}. Install them and try again.`);
  }
  if (!image || !image.index) {
    throw new Error('No Windows To Go image was selected.');
  }

  const body = buildWtgScript({
    isoPath,
    devicePath,
    volumeLabel,
    imageIndex: image.index,
    locale: options.locale || 'en-US',
    description: image.name || 'Windows To Go'
  });

  await runPrivileged({
    body,
    vars: { RUFUS_UNATTEND: UNATTEND_XML },
    onProgress
  });
}

module.exports = {
  ESP_SIZE_MIB,
  REQUIRED_TOOLS,
  UNATTEND_XML,
  parseWimInfo,
  selectWindowsToGoImage,
  buildWtgScript,
  inspectWindowsToGo,
  createWindowsToGo,
  bcd
};
