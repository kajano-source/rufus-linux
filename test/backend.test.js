'use strict';

/**
 * Tests for the pieces that can be verified without root, a USB drive or a
 * Windows image: the generated privileged scripts, the BCD encoder and the
 * Windows image inspection logic.
 *
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shell = require('../backend/shell');
const privilege = require('../backend/privilege');
const isoWriter = require('../backend/iso-writer');
const formatter = require('../backend/formatter');
const wtg = require('../backend/windows-to-go');
const bcd = require('../backend/wtg-bcd');

function bashSyntaxCheck(script) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rufus-test-')), 'script.sh');
  fs.writeFileSync(file, script);
  try {
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- shell.js

test('shellQuote neutralises every shell metacharacter', () => {
  assert.strictEqual(shell.shellQuote('plain'), "'plain'");
  assert.strictEqual(shell.shellQuote("it's"), `'it'\\''s'`);
  assert.strictEqual(shell.shellQuote('a; rm -rf /'), "'a; rm -rf /'");
  assert.strictEqual(shell.shellQuote('$(whoami)'), "'$(whoami)'");
  assert.strictEqual(shell.shellQuote('`id`'), "'`id`'");
});

test('only whole removable disk nodes are writable targets', () => {
  for (const good of ['/dev/sda', '/dev/sdz', '/dev/mmcblk0', '/dev/nvme0n1']) {
    assert.ok(shell.isWritableDevice(good), `${good} should be allowed`);
  }
  for (const bad of ['/dev/sda1', '/dev/nvme0n1p1', '/dev/mmcblk0p1', '/dev/sda; rm -rf /',
    '/dev/disk/by-uuid/1234', '/home/shinuji/Documents', '', null, undefined]) {
    assert.ok(!shell.isWritableDevice(bad), `${bad} must be refused`);
  }
});

test('partitionPath follows the kernel naming rules', () => {
  assert.strictEqual(shell.partitionPath('/dev/sdb', 2), '/dev/sdb2');
  assert.strictEqual(shell.partitionPath('/dev/nvme0n1', 1), '/dev/nvme0n1p1');
  assert.strictEqual(shell.partitionPath('/dev/mmcblk0', 3), '/dev/mmcblk0p3');
});

test('formatBytes is human readable', () => {
  assert.strictEqual(shell.formatBytes(0), '0 B');
  assert.strictEqual(shell.formatBytes(1024), '1.0 KB');
  assert.strictEqual(shell.formatBytes(5 * 1024 ** 3), '5.0 GB');
});

// ------------------------------------------------------------ privilege.js

test('the privileged preamble exposes the marker helpers', () => {
  const preamble = privilege.buildPreamble({ RUFUS_UNATTEND: '<xml>&\'"' });
  assert.ok(preamble.includes('emit()'));
  assert.ok(preamble.includes('fail()'));
  assert.ok(preamble.includes('cancelled()'));
  // Values are quoted, so an answer file can never break out of the script.
  assert.ok(preamble.includes(`RUFUS_UNATTEND='<xml>&'\\''"'`));
  bashSyntaxCheck(preamble);
});

test('the marker helper emits valid, parseable JSON', () => {
  const line = privilege.marker({ stage: 'writing', message: 'it\'s "quoted" \\ ok', percent: 5 });
  const json = line.match(/emit ('.*')$/)[1];
  const value = json.slice(1, -1).replace(/'\\''/g, "'");
  assert.deepStrictEqual(JSON.parse(value).stage, 'writing');
});

// ---------------------------------------------------------- iso-writer.js

test('the ISO writer produces a valid script that elevates exactly once', () => {
  const body = isoWriter.buildWriteScript({
    isoPath: "/tmp/it's a test.iso",
    devicePath: '/dev/sdb',
    partitionScheme: 'GPT'
  });
  bashSyntaxCheck(privilege.buildPreamble() + body);

  // The body must never escalate by itself: the runner owns the single pkexec.
  assert.ok(!body.includes('pkexec'));
  assert.ok(body.includes(`ISO='/tmp/it'\\''s a test.iso'`));
  assert.ok(body.includes('dd if="$ISO" of="$DEVICE"'));
  assert.ok(body.includes('mklabel \'gpt\''));
});

test('the runner performs exactly one pkexec invocation for any operation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'privilege.js'), 'utf8');
  const spawns = source.match(/spawn\('pkexec'/g) || [];
  assert.strictEqual(spawns.length, 1,
    'every operation must go through a single pkexec call, otherwise the password is asked repeatedly');
});

test('the ISO writer refuses to run without a partition scheme label', () => {
  const script = isoWriter.buildWriteScript({ isoPath: '/tmp/a.iso', devicePath: '/dev/sdb' });
  bashSyntaxCheck(script);
  assert.ok(script.includes("parted -s \"$DEVICE\" mklabel 'msdos'"));
});

// ----------------------------------------------------------- formatter.js

test('the formatter maps every filesystem selection to a real mkfs call', () => {
  const cases = {
    FAT32: 'mkfs.vfat -F 32',
    'Large FAT32': 'mkfs.vfat -F 32',
    NTFS: 'mkfs.ntfs -f',
    exFAT: 'mkfs.exfat',
    ext4: 'mkfs.ext4',
    ext2: 'mkfs.ext2'
  };
  for (const [fsType, expected] of Object.entries(cases)) {
    const command = formatter.formatCommandFor(fsType, 'TEST', '/dev/sdb1', true);
    assert.ok(command.includes(expected), `${fsType} should use ${expected}`);
  }
  assert.ok(formatter.formatCommandFor('NTFS', 'TEST', '/dev/sdb1', false).includes('mkfs.ntfs -L'));
  assert.ok(formatter.formatCommandFor('FAT32', "it's", '/dev/sdb1', true).includes(`-n 'it'\\''s'`));
});

test('the formatter script is valid and guards the FAT32 size limit', () => {
  const script = privilege.buildPreamble() + formatter.buildFormatScript({
    devicePath: '/dev/sdb', partitionScheme: 'GPT', fileSystem: 'FAT32', volumeLabel: 'BACKUP'
  });
  bashSyntaxCheck(script);
  assert.ok(script.includes('34359738368'), 'should refuse a >32GB FAT32 volume');
  assert.ok(!formatter.buildFormatScript({
    devicePath: '/dev/sdb', partitionScheme: 'GPT', fileSystem: 'exFAT', volumeLabel: 'BACKUP'
  }).includes('34359738368'), 'the guard only applies to FAT32');
});

// -------------------------------------------------------------- wtg-bcd.js

test('GUIDs are encoded in the mixed-endian layout Windows uses', () => {
  const bytes = bcd.guidToDiskBytes('01234567-89ab-cdef-0123-456789abcdef');
  assert.strictEqual(bytes.length, 16);
  assert.strictEqual(bytes.toString('hex'), '67452301' + 'ab89' + 'efcd' + '0123456789abcdef');
});

test('the device record matches the layout bcdedit produces', () => {
  const record = bcd.buildDeviceRecord('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(record.length, bcd.DEVICE_RECORD_LENGTH);
  assert.strictEqual(record.readUInt32LE(16), 6);
  assert.strictEqual(record.readUInt32LE(24), 72);
  assert.strictEqual(record.readUInt32LE(52), 0, 'GPT signature type');
  assert.strictEqual(record.subarray(32, 48).toString('hex'),
    bcd.guidToDiskBytes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').toString('hex'));
  assert.strictEqual(record.subarray(56, 72).toString('hex'),
    bcd.guidToDiskBytes('11111111-2222-3333-4444-555555555555').toString('hex'));
  assert.strictEqual(record.subarray(0, 16).toString('hex'), '0'.repeat(32));
  assert.strictEqual(record.subarray(72).toString('hex'), '0'.repeat(32));
});

test('MBR devices are flagged as such in the device record', () => {
  const record = bcd.buildDeviceRecord('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '11111111-2222-3333-4444-555555555555', 'mbr');
  assert.strictEqual(record.readUInt32LE(52), 1);
});

test('the hive value encodings match hivexsh syntax', () => {
  assert.strictEqual(bcd.hiveBinary(Buffer.from([0x00, 0xff])), 'hex:3:00,ff');
  assert.strictEqual(bcd.hiveString('en-US'), 'string:en-US');
  assert.strictEqual(bcd.hiveString('naïve'), 'string:na?ve', 'only 7 bit ASCII is supported');
  // REG_MULTI_SZ holding "{guid}\0\0" in UTF-16LE
  const multi = bcd.hiveMultiString(['{b012b84d-c47c-4ed5-b722-c0c42163e569}']);
  assert.ok(multi.startsWith('hex:7:7b,00,62,00,30'));
  assert.ok(multi.endsWith('00,00'));
});

test('the BCD script contains the Windows To Go entry points', () => {
  const script = bcd.buildBcdScript({
    outputPath: '/tmp/BCD',
    diskGuid: '11111111-2222-3333-4444-555555555555',
    espGuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    osGuid: '01234567-89ab-cdef-0123-456789abcdef',
    locale: 'en-US',
    description: 'Windows 11 Enterprise'
  });

  assert.ok(script.includes(`\\Objects\\{${bcd.BOOT_MANAGER_GUID}}\\Elements\\11000001`));
  assert.ok(script.includes(`\\Objects\\{${bcd.LOADER_GUID}}\\Elements\\21000001`));
  assert.ok(script.includes('string:\\WINDOWS\\system32\\winload.efi'));
  assert.ok(script.includes('string:Windows 11 Enterprise'));
  assert.ok(script.includes('string:\\Windows'));
  assert.ok(script.includes('hex:3:00'), 'WinRE is disabled');
  assert.ok(script.includes('commit /tmp/BCD'));
  assert.ok(script.trim().endsWith('quit'));

  // Every element write is the three part hivexsh pattern.
  const writes = script.split('setval 1').length - 1;
  assert.ok(writes >= 11, `expected the full element set, saw ${writes}`);
});

test('existing template keys are not re-added', () => {
  const complete = (guid) => ({ keys: new Set(['description', 'elements']), elements: new Set(['11000001']) });
  const script = bcd.buildBcdScript({
    outputPath: '/tmp/BCD',
    diskGuid: '11111111-2222-3333-4444-555555555555',
    espGuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    osGuid: '01234567-89ab-cdef-0123-456789abcdef',
    locale: 'en-US',
    description: 'Windows 11 Enterprise',
    template: {
      [bcd.BOOT_MANAGER_GUID]: complete(bcd.BOOT_MANAGER_GUID),
      [bcd.LOADER_GUID]: complete(bcd.LOADER_GUID)
    }
  });

  assert.ok(!script.includes('add Description'), 'Description already exists in the template');
  assert.ok(!script.includes('add Elements'), 'Elements already exists in the template');
  assert.ok(!script.includes('add 11000001'), 'the device element already exists');
  assert.ok(script.includes('add 12000005'), 'missing elements must still be created');
  // ... but their values are always rewritten.
  assert.ok(script.includes(`\\Objects\\{${bcd.BOOT_MANAGER_GUID}}\\Elements\\11000001\nsetval 1`));
});

test('hivexsh output is parsed back into a template description', () => {
  const guid = '9dea862c-5cdd-4e70-acc1-f32b344d4795';
  const output = [
    `> cd \\Objects\\{${guid}}`,
    `\\Objects\\{${guid}}\\Description\\`,
    `\\Objects\\{${guid}}\\Elements\\`,
    `\\Objects\\{${guid}}\\Elements\\11000001\\`,
    `\\Objects\\{${guid}}\\Elements\\12000002\\`,
    'quit'
  ].join('\n');

  const parsed = bcd.parseInspectOutput(output);
  const key = bcd.BOOT_MANAGER_GUID;
  assert.ok(parsed[key], 'the object should be recognised');
  assert.ok(parsed[key].keys.has('description'));
  assert.ok(parsed[key].keys.has('elements'));
  assert.ok(parsed[key].elements.has('11000001'));
  assert.ok(parsed[key].elements.has('12000002'));
  assert.ok(!parsed[key].elements.has('21000001'));
});

test('the runtime BCD writer is valid bash', () => {
  const script = privilege.buildPreamble() + bcd.buildBcdWriterBash({
    locale: 'en-US', description: 'Windows 11 Enterprise'
  });
  bashSyntaxCheck(script);
  assert.ok(script.includes('device_record_hex'));
  assert.ok(script.includes('emit_bcd_script'));
});

// ------------------------------------------------------- windows-to-go.js

const WIM_INFO = `
WIM Information:
----------------
Path:           /mnt/iso/sources/install.wim
GUID:           0x1234
Version:        68864
Image Count:    11
Compression:     LZX
Part Number:    1/1
Boot Index:     0
Size:           5601323008 bytes
Architecture:   x86_64

Available Images:
-----------------
Index:                  1
Name:                   Windows 11 Home
Description:            Windows 11 Home
Display Name:           Windows 11 Home
Display Description:    Windows 11 Home
...
Index:                  6
Name:                   Windows 11 Enterprise
Description:            Windows 11 Enterprise
Size:                   14763218944 bytes
`;

test('wimlib output is parsed into images', () => {
  const info = wtg.parseWimInfo(WIM_INFO);
  assert.strictEqual(info.images.length, 2);
  assert.strictEqual(info.images[0].index, 1);
  assert.strictEqual(info.images[0].name, 'Windows 11 Home');
  assert.strictEqual(info.images[1].index, 6);
  assert.strictEqual(info.images[1].size, 14763218944);
  assert.strictEqual(info.architecture, 'x86_64');
});

test('only Enterprise and Education images are accepted for Windows To Go', () => {
  const info = wtg.parseWimInfo(WIM_INFO);
  const chosen = wtg.selectWindowsToGoImage(info.images);
  assert.strictEqual(chosen.index, 6);
  assert.strictEqual(chosen.name, 'Windows 11 Enterprise');

  const homeOnly = [{ index: 1, name: 'Windows 11 Home' }, { index: 2, name: 'Windows 11 Pro' }];
  assert.strictEqual(wtg.selectWindowsToGoImage(homeOnly), null);

  const education = [{ index: 3, name: 'Windows 10 Education' }];
  assert.strictEqual(wtg.selectWindowsToGoImage(education).index, 3);
});

test('the Windows To Go script is valid, single-elevation and ordered', () => {
  const body = wtg.buildWtgScript({
    isoPath: '/tmp/Win11_Enterprise.iso',
    devicePath: '/dev/sdb',
    imageIndex: 6,
    locale: 'en-US',
    description: 'Windows 11 Enterprise'
  });
  bashSyntaxCheck(privilege.buildPreamble() + body);

  assert.ok(!body.includes('pkexec'));
  assert.ok(body.includes('mklabel gpt'));
  assert.ok(body.includes('mkpart "EFI system partition" fat32 1MiB 261MiB'));
  assert.ok(body.includes('set 1 esp on'));
  assert.ok(body.includes('mkpart "Windows" ntfs 261MiB 100%'));
  assert.ok(body.includes('mkfs.vfat -F 32 -n "RUFUS-ESP"'));
  assert.ok(body.includes('wimlib-imagex apply'));
  assert.ok(body.includes('Windows/System32/config/BCD-Template'));
  assert.ok(body.includes('Windows/Boot/EFI'));
  assert.ok(body.includes('hivexsh -w -f'));
  assert.ok(body.includes('Windows/Panther/Unattend.xml'));

  // The stick is only erased after the image has been validated.
  const validateAt = body.indexOf('grep -Eqi "^Name:.*(Enterprise|Education)"');
  const wipeAt = body.indexOf('wipefs --all --force');
  assert.ok(validateAt > 0 && wipeAt > validateAt, 'validation must run before the wipe');
});

test('the Windows To Go answer file reaches the script as a quoted value', () => {
  const body = wtg.buildWtgScript({
    isoPath: '/tmp/a.iso', devicePath: '/dev/sdb', imageIndex: 1, locale: 'en-US', description: 'Windows'
  });
  // The body only ever references the variable; the value is quoted into the
  // preamble by the runner, so XML metacharacters cannot escape.
  assert.ok(body.includes('"$RUFUS_UNATTEND" > "$ISO_MOUNT/Windows/Panther/Unattend.xml"'));

  const preamble = privilege.buildPreamble({ RUFUS_UNATTEND: wtg.UNATTEND_XML });
  bashSyntaxCheck(preamble + body);
  assert.ok(preamble.includes("RUFUS_UNATTEND='<?xml version=\"1.0\""));
});

test('the Windows To Go answer file bypasses the online account screen', () => {
  assert.ok(wtg.UNATTEND_XML.includes('<HideOnlineAccountScreens>true</HideOnlineAccountScreens>'));
  assert.ok(wtg.UNATTEND_XML.includes('pass="oobeSystem"'));
  assert.ok(!wtg.UNATTEND_XML.includes('windowsPE'));
});
