'use strict';

/**
 * Boot Configuration Data generation for Windows To Go.
 *
 * A Windows To Go stick needs a BCD that boots `winload.efi` straight out of an
 * applied Windows image, which is what Rufus calls the "Windows Boot Loader"
 * entry. Everything here is pure string/buffer work so it can be unit tested
 * without root, without a USB drive and without hivex installed.
 *
 * Layout of the generated store (element ids are the BCD type ids):
 *
 *   \Objects\{9dea862c-...}\Elements      Windows Boot Manager (bootmgfw.efi)
 *     11000001  device            -> EFI system partition record
 *     12000005  locale
 *     23000003  default           -> {loader}
 *     24000001  display order     -> REG_MULTI_SZ {"{loader}"}
 *
 *   \Objects\{b012b84d-...}\Elements      Windows Boot Loader (winload.efi)
 *     11000001  device            -> Windows partition record
 *     21000001  os device         -> Windows partition record
 *     12000002  path              -> \WINDOWS\system32\winload.efi
 *     12000004  description
 *     12000005  locale
 *     22000002  system root       -> \Windows
 *     16000009  WinRE disabled    -> 0x00
 */

const BOOT_MANAGER_GUID = '9dea862c-5cdd-4e70-acc1-f32b344d4795';
const LOADER_GUID = 'b012b84d-c47c-4ed5-b722-c0c42163e569';
const BOOT_MANAGER_TYPE = 0x10200003;
const LOADER_TYPE = 0x10200004;

const ESP_TYPE_GUID = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b';
const WINDOWS_TYPE_GUID = 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7';

const REG_BINARY = 3;
const REG_MULTI_SZ = 7;

const DEVICE_RECORD_LENGTH = 88;

/**
 * Convert a textual GUID into the mixed-endian "disk bytes" layout Windows
 * stores inside device records (first three groups are little endian).
 */
function guidToDiskBytes(guid) {
  const hex = String(guid).trim().replace(/[{}-]/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid GUID: ${guid}`);
  }
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.from([
    bytes[3], bytes[2], bytes[1], bytes[0],
    bytes[5], bytes[4],
    bytes[7], bytes[6],
    bytes[8], bytes[9], bytes[10], bytes[11],
    bytes[12], bytes[13], bytes[14], bytes[15]
  ]);
}

/**
 * Build the 88 byte device descriptor that bcdedit writes for
 * `bcdedit /set {id} device partition=<x>` on a GPT disk:
 *
 *   0x00  16 zero bytes
 *   0x10  uint64  6            (offset of the partition identifier)
 *   0x18  uint64  72           (length of the whole record)
 *   0x20  16 bytes             partition GUID
 *   0x30  uint32  signature type (0 = GPT, 1 = MBR) + padding
 *   0x38  16 bytes             disk GUID
 *   0x48  16 zero bytes
 */
function buildDeviceRecord(partitionGuid, diskGuid, scheme = 'gpt') {
  const record = Buffer.alloc(DEVICE_RECORD_LENGTH);
  record.writeUInt32LE(6, 16);
  record.writeUInt32LE(72, 24);
  guidToDiskBytes(partitionGuid).copy(record, 32);
  record.writeUInt32LE(scheme === 'mbr' ? 1 : 0, 52);
  guidToDiskBytes(diskGuid).copy(record, 56);
  return record;
}

function hiveBinary(buffer) {
  const parts = Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0'));
  return `hex:${REG_BINARY}:${parts.join(',')}`;
}

function hiveString(value) {
  // hivexsh only accepts 7 bit ASCII for `string:` values.
  const ascii = String(value).replace(/[^\x20-\x7e]/g, '?');
  return `string:${ascii}`;
}

function hiveMultiString(values) {
  const text = `${values.join('\u0000')}\u0000\u0000`;
  const buffer = Buffer.from(text, 'utf16le');
  const parts = Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0'));
  return `hex:${REG_MULTI_SZ}:${parts.join(',')}`;
}

/**
 * Elements written for each object, in a stable order.
 */
function planElements({ diskGuid, espGuid, osGuid, locale, description, scheme = 'gpt' }) {
  const espRecord = buildDeviceRecord(espGuid, diskGuid, scheme);
  const osRecord = buildDeviceRecord(osGuid, diskGuid, scheme);
  const loaderValue = `{${LOADER_GUID}}`;

  return {
    [BOOT_MANAGER_GUID]: [
      { id: '11000001', value: hiveBinary(espRecord), comment: 'Windows Boot Manager device (ESP)' },
      { id: '12000005', value: hiveString(locale), comment: 'Windows Boot Manager locale' },
      { id: '23000003', value: hiveString(loaderValue), comment: 'default Windows Boot Loader' },
      { id: '24000001', value: hiveMultiString([loaderValue]), comment: 'display order' }
    ],
    [LOADER_GUID]: [
      { id: '11000001', value: hiveBinary(osRecord), comment: 'device (Windows volume)' },
      { id: '21000001', value: hiveBinary(osRecord), comment: 'OS device (Windows volume)' },
      { id: '12000002', value: hiveString('\\WINDOWS\\system32\\winload.efi'), comment: 'boot application' },
      { id: '12000004', value: hiveString(description), comment: 'description' },
      { id: '12000005', value: hiveString(locale), comment: 'locale' },
      { id: '22000002', value: hiveString('\\Windows'), comment: 'system root' },
      { id: '16000009', value: hiveBinary(Buffer.from([0x00])), comment: 'disable Windows Recovery Environment' }
    ]
  };
}

/**
 * Emit the hivexsh commands that write one element.
 * `existingElements` lists the element ids already present in the template so we
 * only `add` the ones that are missing (hivexsh fails on an existing key).
 */
function emitElement(objectGuid, element, existingElements) {
  const base = `\\Objects\\{${objectGuid}}\\Elements`;
  const lines = [];
  if (!existingElements || !existingElements.has(element.id)) {
    lines.push(`cd ${base}`);
    lines.push(`add ${element.id}`);
  }
  lines.push(`cd ${base}\\${element.id}`);
  lines.push('setval 1');
  lines.push('Element');
  lines.push(element.value);
  return lines;
}

/**
 * Emit creation of the object key itself (Description/Type + Elements) when the
 * shipped BCD-Template does not already contain it.
 */
function emitObject(objectGuid, type, existing) {
  const lines = [];
  const base = `\\Objects\\{${objectGuid}}`;
  if (!existing || !existing.has('description')) {
    lines.push(`cd ${base}`);
    lines.push('add Description');
    lines.push(`cd ${base}\\Description`);
    lines.push('setval 1');
    lines.push('Type');
    lines.push(`dword:0x${type.toString(16)}`);
  }
  if (!existing || !existing.has('elements')) {
    lines.push(`cd ${base}`);
    lines.push('add Elements');
  }
  return lines;
}

/**
 * Build the complete hivexsh script that turns a BCD-Template (extracted from the
 * Windows image itself) into a Windows To Go store.
 *
 * @param {object}  options
 * @param {string}  options.outputPath   where `commit` writes the new store
 * @param {string}  options.diskGuid     GPT disk GUID
 * @param {string}  options.espGuid      GPT GUID of the EFI system partition
 * @param {string}  options.osGuid       GPT GUID of the Windows partition
 * @param {string}  options.locale       BCD locale, e.g. "en-US"
 * @param {string}  options.description  Windows edition, e.g. "Windows 11 Enterprise"
 * @param {object}  options.template      { [objectGuid]: { keys:Set, elements:Set } }
 */
function buildBcdScript(options) {
  const { outputPath, diskGuid, espGuid, osGuid, locale, description, scheme = 'gpt', template = {} } = options;

  const elements = planElements({ diskGuid, espGuid, osGuid, locale, description, scheme });
  const lines = [];

  for (const [objectGuid, objectElements] of Object.entries(elements)) {
    const info = template[objectGuid] || {};
    const type = objectGuid === BOOT_MANAGER_GUID ? BOOT_MANAGER_TYPE : LOADER_TYPE;
    lines.push(...emitObject(objectGuid, type, info.keys));
    for (const element of objectElements) {
      lines.push(...emitElement(objectGuid, element, info.elements));
    }
  }

  lines.push(`commit ${outputPath}`);
  lines.push('quit');
  return `${lines.join('\n')}\n`;
}

/**
 * Script that reports which subkeys exist under an object, used to decide what
 * the write script has to create.
 */
function buildInspectScript(objectGuids = [BOOT_MANAGER_GUID, LOADER_GUID]) {
  const lines = [];
  for (const guid of objectGuids) {
    lines.push(`cd \\Objects\\{${guid}}`);
    lines.push('ls');
    lines.push(`cd \\Objects\\{${guid}}\\Elements`);
    lines.push('ls');
  }
  lines.push('quit');
  return `${lines.join('\n')}\n`;
}

/**
 * Parse hivexsh `ls` output into { [objectGuid]: { keys:Set, elements:Set } }.
 * hivexsh prints absolute key paths, one per line, each ending in a backslash.
 */
/**
 * hivexsh prints key paths like
 *   \Objects\{9dea862c-...}\Description\
 *   \Objects\{9dea862c-...}\Elements\11000001\
 */
const KEY_PATH_PATTERN = /^\\Objects\\\{([0-9a-f-]{36})\}(\\Elements)?\\([^\\]+)\\?$/i;

function parseInspectOutput(output) {
  const result = {};

  for (const rawLine of String(output).split('\n')) {
    const match = rawLine.trim().match(KEY_PATH_PATTERN);
    if (!match) continue;
    const [, guid, elementsPart, name] = match;
    const key = guid.toLowerCase();
    if (!result[key]) {
      result[key] = { keys: new Set(), elements: new Set() };
    }
    if (elementsPart) {
      result[key].elements.add(name.toLowerCase());
    } else {
      result[key].keys.add(name.toLowerCase());
    }
  }

  return result;
}

/**
 * The disk and partition GUIDs only exist once the stick has been partitioned,
 * which happens inside the privileged transaction. hivexsh is not a shell, so
 * the script that writes the store is generated *by* the privileged script, with
 * the identifiers resolved at that point. This returns the bash that does it;
 * the BCD knowledge itself still lives in this module.
 *
 * Expects these shell variables to exist when called: DISK_GUID, ESP_GUID,
 * OS_GUID and BCD_TEMPLATE, and writes the hivex script to $1.
 */
function buildBcdWriterBash({ locale = 'en-US', description = 'Windows To Go' } = {}) {
  // Descriptions and locales end up inside a bash heredoc, so keep them to a
  // harmless character set (no $, no backticks, no backslashes).
  const safe = (value) => String(value).replace(/[^A-Za-z0-9 ._+()-]/g, '?').slice(0, 64);
  const safeLocale = safe(locale);
  const safeDescription = safe(description);
  const loaderValue = hiveMultiString([`{${LOADER_GUID}}`]);
  const loaderString = hiveString(`{${LOADER_GUID}}`).slice('string:'.length);
  const bootManagerType = BOOT_MANAGER_TYPE.toString(16);
  const loaderType = LOADER_TYPE.toString(16);

  return `
BM_GUID='${BOOT_MANAGER_GUID}'
LOADER_GUID='${LOADER_GUID}'

# GUID -> mixed endian "disk bytes", the layout Windows stores in device records.
guid_disk_bytes() {
  local hex="\${1//-/}" i out=""
  # The first three groups are little endian, the remaining eight bytes are not.
  for i in 6 4 2 0 10 8 14 12; do out="$out\${hex:$i:2},"; done
  for i in 16 18 20 22 24 26 28 30; do out="$out\${hex:$i:2},"; done
  printf '%s' "\${out%,}"
}

# 88 byte device descriptor, i.e. what bcdedit writes for
# "bcdedit /set {id} device partition=<guid>" on a GPT disk.
device_record_hex() {
  printf '00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,'
  printf '06,00,00,00,00,00,00,00,'
  printf '48,00,00,00,00,00,00,00,'
  printf '%s,' "$(guid_disk_bytes "$1")"
  printf '00,00,00,00,'
  printf '00,00,00,00,'
  printf '%s,' "$(guid_disk_bytes "$DISK_GUID")"
  printf '00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00'
}

# hivexsh prints full key paths, each terminated by a backslash.
bcd_has() {
  printf '%s' "$1" | grep -Fqi -- "$2\\\\"
}

bcd_dump_object() {
  printf 'cd \\\\Objects\\\\{%s}\\nls\\ncd \\\\Objects\\\\{%s}\\\\Elements\\nls\\nquit\\n' "$1" "$1" \\
    | hivexsh "$BCD_TEMPLATE" 2>/dev/null | tr 'A-Z' 'a-z'
}

# $1 object guid, $2 element id, $3 hive value, $4 object dump
bcd_emit_element() {
  if ! bcd_has "$4" "$2"; then
    printf 'cd \\\\Objects\\\\{%s}\\\\Elements\\nadd %s\\n' "$1" "$2"
  fi
  printf 'cd \\\\Objects\\\\{%s}\\\\Elements\\\\%s\\nsetval 1\\nElement\\n%s\\n' "$1" "$2" "$3"
}

# Writes the hivex script to "$1". DISK_GUID/ESP_GUID/OS_GUID/BCD_TEMPLATE and
# BCD_OUT must already be set by the caller.
emit_bcd_script() {
  local bm_dump loader_dump esp os
  bm_dump="$(bcd_dump_object "$BM_GUID")"
  loader_dump="$(bcd_dump_object "$LOADER_GUID")"
  esp="$(device_record_hex "$ESP_GUID")"
  os="$(device_record_hex "$OS_GUID")"

  if ! bcd_has "$bm_dump" "description"; then
    printf 'cd \\\\Objects\\\\{%s}\\nadd Description\\ncd \\\\Objects\\\\{%s}\\\\Description\\nsetval 1\\nType\\ndword:0x${bootManagerType}\\n' \\
      "$BM_GUID" "$BM_GUID"
  fi
  if ! bcd_has "$bm_dump" "elements"; then
    printf 'cd \\\\Objects\\\\{%s}\\nadd Elements\\n' "$BM_GUID"
  fi
  if ! bcd_has "$loader_dump" "description"; then
    printf 'cd \\\\Objects\\\\{%s}\\nadd Description\\ncd \\\\Objects\\\\{%s}\\\\Description\\nsetval 1\\nType\\ndword:0x${loaderType}\\n' \\
      "$LOADER_GUID" "$LOADER_GUID"
  fi
  if ! bcd_has "$loader_dump" "elements"; then
    printf 'cd \\\\Objects\\\\{%s}\\nadd Elements\\n' "$LOADER_GUID"
  fi

  bcd_emit_element "$BM_GUID" 11000001 "hex:3:$esp" "$bm_dump"
  bcd_emit_element "$BM_GUID" 12000005 "string:${safeLocale}" "$bm_dump"
  bcd_emit_element "$BM_GUID" 23000003 "string:${loaderString}" "$bm_dump"
  bcd_emit_element "$BM_GUID" 24000001 "${loaderValue}" "$bm_dump"

  bcd_emit_element "$LOADER_GUID" 11000001 "hex:3:$os" "$loader_dump"
  bcd_emit_element "$LOADER_GUID" 21000001 "hex:3:$os" "$loader_dump"
  bcd_emit_element "$LOADER_GUID" 12000002 'string:\\WINDOWS\\system32\\winload.efi' "$loader_dump"
  bcd_emit_element "$LOADER_GUID" 12000004 "string:${safeDescription}" "$loader_dump"
  bcd_emit_element "$LOADER_GUID" 12000005 "string:${safeLocale}" "$loader_dump"
  bcd_emit_element "$LOADER_GUID" 22000002 'string:\\Windows' "$loader_dump"
  bcd_emit_element "$LOADER_GUID" 16000009 "hex:3:00" "$loader_dump"

  printf 'commit %s\\nquit\\n' "$BCD_OUT"
} > "$1"
`;
}

module.exports = {
  BOOT_MANAGER_GUID,
  LOADER_GUID,
  BOOT_MANAGER_TYPE,
  LOADER_TYPE,
  ESP_TYPE_GUID,
  WINDOWS_TYPE_GUID,
  DEVICE_RECORD_LENGTH,
  guidToDiskBytes,
  buildDeviceRecord,
  hiveBinary,
  hiveString,
  hiveMultiString,
  planElements,
  buildBcdScript,
  buildBcdWriterBash,
  buildInspectScript,
  parseInspectOutput
};
