// ============================================
// Rufus Linux Replica - Renderer Process
// ============================================

// State
let currentDrives = [];
let selectedDrive = null;
let selectedIso = null;
let isFlashing = false;
let elapsedTimer = null;
let elapsedSeconds = 0;
let logEntries = [];
let bootMode = 'select'; // 'select' or 'download'
let wtgPlan = null;       // last successful Windows To Go inspection
let wtgChecking = false;  // inspection in flight

// DOM Elements
const deviceSelect = document.getElementById('device-select');
const bootSelect = document.getElementById('boot-select');
const btnSelectIso = document.getElementById('btn-select-iso');
const btnBootDropdown = document.getElementById('btn-boot-dropdown');
const bootDropdownMenu = document.getElementById('boot-dropdown-menu');
const isoCheck = document.getElementById('iso-check');
const imageOptionRow = document.getElementById('image-option-row');
const imageOptionSelect = document.getElementById('image-option-select');
const persistentPartitionRow = document.getElementById('persistent-partition-row');
const partitionTargetRow = document.getElementById('partition-target-row');
const partitionScheme = document.getElementById('partition-scheme');
const targetSystem = document.getElementById('target-system');
const volumeLabel = document.getElementById('volume-label');
const fileSystem = document.getElementById('file-system');
const clusterSize = document.getElementById('cluster-size');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const btnStart = document.getElementById('btn-start');
const btnClose = document.getElementById('btn-close');
const statusLeft = document.getElementById('status-left');
const statusRight = document.getElementById('status-right');

// Collapsible toggles
const advDriveToggle = document.getElementById('adv-drive-toggle');
const advDrivePanel = document.getElementById('adv-drive-panel');
const advFormatToggle = document.getElementById('adv-format-toggle');
const advFormatPanel = document.getElementById('adv-format-panel');

// Checkboxes
const chkRufusMbr = document.getElementById('chk-rufus-mbr');
const biosIdSelect = document.getElementById('bios-id-select');
const chkBadblocks = document.getElementById('chk-badblocks');
const badblockPasses = document.getElementById('badblock-passes');

// Dialogs
const dialogOverlay = document.getElementById('dialog-overlay');
const dialogDownload = document.getElementById('dialog-download');
const dialogWinux = document.getElementById('dialog-winux');
const dialogHash = document.getElementById('dialog-hash');
const dialogConfirm = document.getElementById('dialog-confirm');
const dialogAbout = document.getElementById('dialog-about');
const dialogLog = document.getElementById('dialog-log');
const dialogWtg = document.getElementById('dialog-wtg');

// ============================================
// Logging
// ============================================
function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${message}`;
  logEntries.push(entry);
  console.log(entry);
}

// ============================================
// Title Bar Controls
// ============================================
document.getElementById('btn-minimize').addEventListener('click', () => window.rufus.minimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.rufus.maximize());
document.getElementById('btn-close').addEventListener('click', () => {
  if (isFlashing) return; // Prevent close during flash
  window.rufus.close();
});

// ============================================
// USB Drive Updates
// ============================================
window.rufus.onDrivesUpdated((drives) => {
  currentDrives = drives;
  updateDeviceSelect();
});

function updateDeviceSelect() {
  const previousValue = deviceSelect.value;
  deviceSelect.innerHTML = '';

  if (currentDrives.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No USB drive detected';
    deviceSelect.appendChild(opt);
    statusLeft.textContent = '0 device found';
  } else {
    currentDrives.forEach(drive => {
      const opt = document.createElement('option');
      opt.value = drive.path;
      opt.textContent = drive.displayName;
      deviceSelect.appendChild(opt);
    });

    // Restore selection if still available
    if (previousValue && currentDrives.find(d => d.path === previousValue)) {
      deviceSelect.value = previousValue;
    }

    statusLeft.textContent = `${currentDrives.length} device${currentDrives.length > 1 ? 's' : ''} found`;
  }

  selectedDrive = currentDrives.find(d => d.path === deviceSelect.value) || null;
}

deviceSelect.addEventListener('change', () => {
  selectedDrive = currentDrives.find(d => d.path === deviceSelect.value) || null;
  log(`Device selected: ${selectedDrive ? selectedDrive.displayName : 'none'}`);
  // The Windows To Go plan is validated against the target size.
  if (wtgPlan) checkWindowsToGo();
});

// ============================================
// Boot Selection
// ============================================
bootSelect.addEventListener('change', () => {
  const val = bootSelect.value;
  updateUIForBootSelection(val);
});

function updateUIForBootSelection(val) {
  if (val === 'non-bootable') {
    // Non-bootable mode: hide ISO-related fields
    imageOptionRow.style.display = 'none';
    persistentPartitionRow.style.display = 'none';
    isoCheck.style.display = 'none';
    btnSelectIso.style.display = 'none';
    btnBootDropdown.style.display = 'none';
    volumeLabel.value = 'USB_DRIVE';

    // Show partition options for format
    partitionTargetRow.style.display = 'flex';

    // Update file systems for non-bootable
    fileSystem.innerHTML = `
      <option value="FAT32" selected>FAT32 (Default)</option>
      <option value="Large FAT32">Large FAT32</option>
      <option value="NTFS">NTFS</option>
      <option value="exFAT">exFAT</option>
      <option value="ext4">ext4</option>
      <option value="ext2">ext2</option>
    `;

    log('Boot selection: Non bootable (format only)');
  } else if (val === 'freedos') {
    imageOptionRow.style.display = 'none';
    persistentPartitionRow.style.display = 'none';
    isoCheck.style.display = 'none';
    btnSelectIso.style.display = 'none';
    btnBootDropdown.style.display = 'none';
    partitionTargetRow.style.display = 'flex';
    volumeLabel.value = 'FREEDOS';
    log('Boot selection: FreeDOS');
  } else {
    // Disk or ISO image
    imageOptionRow.style.display = selectedIso ? '' : 'none';
    partitionTargetRow.style.display = 'flex';
    btnSelectIso.style.display = '';
    btnBootDropdown.style.display = '';

    if (selectedIso) {
      isoCheck.style.display = '';
    }
    log('Boot selection: Disk or ISO image');
  }
}

// ============================================
// SELECT / DOWNLOAD Toggle
// ============================================
btnBootDropdown.addEventListener('click', (e) => {
  e.stopPropagation();
  bootDropdownMenu.style.display = bootDropdownMenu.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('click', () => {
  bootDropdownMenu.style.display = 'none';
});

bootDropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = item.dataset.action;
    bootDropdownMenu.style.display = 'none';

    if (action === 'select') {
      bootMode = 'select';
      btnSelectIso.textContent = 'SELECT';
      log('Mode: SELECT (local ISO)');
    } else if (action === 'download') {
      bootMode = 'download';
      btnSelectIso.textContent = 'DOWNLOAD';
      log('Mode: DOWNLOAD');
    }
  });
});

// ============================================
// ISO Selection
// ============================================
btnSelectIso.addEventListener('click', async () => {
  if (bootMode === 'download') {
    showDialog('download');
    return;
  }

  const result = await window.rufus.selectIso();
  if (!result) return;

  selectedIso = result;
  wtgPlan = null;
  setWtgStatus('', '');
  log(`ISO selected: ${result.name} (${formatBytes(result.size)})`);

  // Update boot selection text
  const isoOption = bootSelect.querySelector('option[value="disk-iso"]');
  if (isoOption) {
    isoOption.textContent = result.name;
  }
  bootSelect.value = 'disk-iso';

  // Show check icon
  isoCheck.style.display = '';

  // Get ISO info and update UI
  const info = await window.rufus.getIsoInfo(result.path);
  if (info) {
    volumeLabel.value = info.label || result.name.replace(/\.[^.]+$/, '');

    if (info.isWindows) {
      // Windows ISO settings
      imageOptionRow.style.display = '';
      imageOptionSelect.innerHTML = `
        <option value="standard">Standard Windows installation</option>
        <option value="windows-to-go">Windows To Go</option>
      `;
      imageOptionSelect.value = 'standard';
      wtgPlan = null;
      setWtgStatus('', '');
      persistentPartitionRow.style.display = 'none';
      partitionScheme.value = 'GPT';
      targetSystem.value = 'UEFI (non CSM)';
      fileSystem.innerHTML = `
        <option value="NTFS" selected>NTFS</option>
        <option value="FAT32">FAT32</option>
        <option value="Large FAT32">Large FAT32</option>
      `;
    } else if (info.isLinux) {
      // Linux ISO settings
      imageOptionRow.style.display = 'none';
      persistentPartitionRow.style.display = '';
      partitionScheme.value = 'MBR';
      targetSystem.value = 'BIOS or UEFI';
      fileSystem.innerHTML = `
        <option value="FAT32" selected>FAT32 (Default)</option>
        <option value="Large FAT32">Large FAT32</option>
        <option value="ext4">ext4</option>
      `;
    } else {
      // Generic ISO
      imageOptionRow.style.display = 'none';
      persistentPartitionRow.style.display = 'none';
      fileSystem.innerHTML = `
        <option value="FAT32" selected>FAT32 (Default)</option>
        <option value="Large FAT32">Large FAT32</option>
        <option value="NTFS">NTFS</option>
      `;
    }
  }

  // Update status
  statusLeft.textContent = `${result.name} (${formatBytes(result.size)})`;
});

// ============================================
// Partition Scheme <-> Target System Link
// ============================================
partitionScheme.addEventListener('change', () => {
  if (partitionScheme.value === 'GPT') {
    targetSystem.value = 'UEFI (non CSM)';
  } else {
    targetSystem.value = 'BIOS or UEFI';
  }
});

// ============================================
// Collapsible Sections
// ============================================
function setupCollapsible(toggle, panel) {
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.collapse-arrow');
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : '';
    arrow.classList.toggle('open', !isOpen);
    toggle.innerHTML = `<span class="collapse-arrow ${!isOpen ? 'open' : ''}">&#x25B6;</span> ${isOpen ? 'Show' : 'Hide'} ${toggle.id.includes('drive') ? 'advanced drive properties' : 'advanced format options'}`;
  });
}

setupCollapsible(advDriveToggle, advDrivePanel);
setupCollapsible(advFormatToggle, advFormatPanel);

// Checkbox enables
chkRufusMbr.addEventListener('change', () => {
  biosIdSelect.disabled = !chkRufusMbr.checked;
});

chkBadblocks.addEventListener('change', () => {
  badblockPasses.disabled = !chkBadblocks.checked;
});

// ============================================
// Windows To Go
// ============================================
imageOptionSelect.addEventListener('change', () => {
  wtgPlan = null;
  if (imageOptionSelect.value === 'windows-to-go') {
    log('Image option: Windows To Go');
    checkWindowsToGo();
  } else {
    setWtgStatus('', '');
    log('Image option: Standard Windows installation');
  }
});

/**
 * Read the Windows image and report what would be installed. This is what makes
 * the To Go option meaningful instead of silently falling back to a plain dd.
 */
async function checkWindowsToGo() {
  if (!selectedIso) return null;
  const device = deviceSelect.value;
  if (!device) {
    log('Windows To Go: select a USB drive first');
    return null;
  }

  wtgChecking = true;
  setWtgStatus('Checking the Windows image...', 'checking');
  log('Windows To Go: inspecting the Windows image (administrator access is required)');

  const result = await window.rufus.inspectWindowsToGo({ isoPath: selectedIso.path, devicePath: device });

  wtgChecking = false;
  if (result.success) {
    wtgPlan = result;
    const summary = `${result.image.name} (image ${result.image.index}, ${formatBytes(result.image.size)})`;
    setWtgStatus(summary, 'ready');
    log(`Windows To Go ready: ${summary}`);
  } else {
    wtgPlan = null;
    setWtgStatus(result.error, 'error');
    log(`Windows To Go error: ${result.error}`);
  }
  return wtgPlan;
}

function setWtgStatus(text, state) {
  const box = document.getElementById('wtg-status');
  if (!box) return;
  box.style.display = text ? '' : 'none';
  box.textContent = text;
  box.className = `wtg-status ${state || ''}`.trim();
}

document.getElementById('btn-wtg-ok').addEventListener('click', () => {
  hideAllDialogs();
  showConfirmDialog(deviceSelect.value, bootSelect.value);
});

document.getElementById('btn-wtg-cancel').addEventListener('click', () => {
  hideAllDialogs();
});

document.getElementById('btn-wtg-check').addEventListener('click', () => {
  checkWindowsToGo();
});

// ============================================
// START / CLOSE Buttons
// ============================================
btnStart.addEventListener('click', async () => {
  if (isFlashing) return;

  const bootVal = bootSelect.value;
  const device = deviceSelect.value;

  if (!device) {
    log('ERROR: No device selected');
    return;
  }

  if (bootVal === 'disk-iso' && !selectedIso) {
    log('ERROR: No ISO selected');
    return;
  }

  // Windows To Go has its own explanation screen: it is not a dd of the ISO.
  if (bootVal === 'disk-iso' && selectedIso && imageOptionSelect.value === 'windows-to-go') {
    document.getElementById('wtg-image-name').textContent = selectedIso.name;
    document.getElementById('wtg-target').textContent = (currentDrives.find(d => d.path === device) || {}).displayName || device;

    if (!wtgPlan && !wtgChecking) {
      await checkWindowsToGo();
    }

    const planText = document.getElementById('wtg-plan');
    if (wtgPlan) {
      planText.textContent = `${wtgPlan.image.name} - image ${wtgPlan.image.index} - ${formatBytes(wtgPlan.image.size)}`;
      planText.className = 'wtg-plan ok';
    } else {
      planText.textContent = 'This Windows image cannot be used for Windows To Go.';
      planText.className = 'wtg-plan error';
    }
    showDialog('wtg');
    return;
  }

  // For Windows ISOs, show the Windows UX dialog first
  if (bootVal === 'disk-iso' && selectedIso) {
    const info = await window.rufus.getIsoInfo(selectedIso.path);
    if (info && info.isWindows) {
      showDialog('winux');
      return; // The winux OK handler will call startFlashProcess
    }
  }

  // Show confirmation dialog
  showConfirmDialog(device, bootVal);
});

function showConfirmDialog(device, bootVal) {
  const drive = currentDrives.find(d => d.path === device);
  const driveName = drive ? drive.displayName : device;
  document.getElementById('confirm-detail').innerHTML =
    `To continue with this operation, click OK. To quit click Cancel.<br><br>` +
    `Target: <strong>${driveName}</strong>`;
  showDialog('confirm');
}

document.getElementById('btn-confirm-ok').addEventListener('click', () => {
  hideAllDialogs();
  startFlashProcess();
});

document.getElementById('btn-confirm-cancel').addEventListener('click', () => {
  hideAllDialogs();
});

async function startFlashProcess() {
  const bootVal = bootSelect.value;
  const device = deviceSelect.value;

  if (!device) return;

  isFlashing = true;
  btnStart.disabled = true;
  btnClose.textContent = 'CANCEL';
  elapsedSeconds = 0;
  startTimer();

  const isWtg = bootVal === 'disk-iso' && imageOptionSelect.value === 'windows-to-go' && wtgPlan;

  const options = {
    isoPath: selectedIso ? selectedIso.path : null,
    devicePath: device,
    bootSelection: bootVal === 'non-bootable' ? 'non-bootable' : 'bootable',
    // This is the value that used to be dropped on the floor, which is why the
    // To Go option behaved exactly like a standard install.
    imageOption: isWtg ? 'windows-to-go' : 'standard',
    wtgImage: isWtg ? wtgPlan.image : null,
    partitionScheme: partitionScheme.value,
    fileSystem: fileSystem.value,
    volumeLabel: volumeLabel.value,
    clusterSize: clusterSize.value,
    quickFormat: document.getElementById('chk-quick-format').checked
  };

  log(`Starting ${isWtg ? 'Windows To Go' : bootVal === 'non-bootable' ? 'format' : 'flash'} on ${device}`);

  setProgress(0, isWtg ? 'Preparing...' : bootVal === 'non-bootable' ? 'Formatting...' : 'Writing...', false);

  const result = await window.rufus.startFlash(options);

  isFlashing = false;
  stopTimer();
  btnStart.disabled = false;
  btnClose.textContent = 'CLOSE';

  if (result.success) {
    setProgress(100, 'READY', true);
    log('Operation completed successfully');
    statusLeft.textContent = `${currentDrives.length} device${currentDrives.length > 1 ? 's' : ''} found`;
  } else {
    setProgress(0, 'FAILED', false, true);
    log(`ERROR: ${result.error}`);
  }
}

btnClose.addEventListener('click', async () => {
  if (isFlashing) {
    // Cancel operation
    log('Cancelling operation...');
    await window.rufus.cancelFlash();
    isFlashing = false;
    stopTimer();
    btnStart.disabled = false;
    btnClose.textContent = 'CLOSE';
    setProgress(0, 'READY', false);
  } else {
    window.rufus.close();
  }
});

// ============================================
// Windows UX Dialog
// ============================================
document.getElementById('btn-winux-ok').addEventListener('click', () => {
  hideAllDialogs();
  // Show confirm dialog
  showConfirmDialog(deviceSelect.value, bootSelect.value);
});

document.getElementById('btn-winux-cancel').addEventListener('click', () => {
  hideAllDialogs();
});

// ============================================
// Progress
// ============================================
window.rufus.onFlashProgress((progress) => {
  // Stage messages drive the label; progress events carry the numbers.
  const stages = {
    inspecting: 'Reading Windows image...',
    unmounting: 'Unmounting partitions...',
    partitioning: 'Creating partition table...',
    formatting: 'Formatting...',
    applying: 'Applying Windows image...',
    'boot-config': 'Creating boot configuration...',
    finalizing: 'Configuring first boot...',
    writing: 'Writing ISO image...',
    syncing: 'Syncing...'
  };

  if (progress.stage && stages[progress.stage]) {
    progressText.textContent = stages[progress.stage];
    progressBar.classList.add('active');
  }

  if (progress.percent !== undefined) {
    const isComplete = progress.stage === 'complete';
    const isError = progress.stage === 'error' || progress.stage === 'cancelled';
    setProgress(progress.percent, isComplete ? 'READY' : progress.message, isComplete, isError);
  }

  if (progress.detail) {
    statusLeft.textContent = progress.detail;
  }
});

function setProgress(percent, text, isComplete, isError) {
  progressBar.style.width = percent + '%';
  // Progress-only events carry no message; keep whatever the stage set.
  if (text !== undefined && text !== null) {
    progressText.textContent = text;
  }

  progressBar.classList.remove('active', 'error');
  progressText.classList.remove('on-green');

  if (isComplete) {
    progressBar.classList.add('active');
    progressText.classList.add('on-green');
  } else if (isError) {
    progressBar.classList.add('error');
  } else if (percent > 0) {
    progressBar.classList.add('active');
    if (percent > 50) {
      progressText.classList.add('on-green');
    }
  }
}

// ============================================
// Timer
// ============================================
function startTimer() {
  elapsedSeconds = 0;
  updateTimerDisplay();
  elapsedTimer = setInterval(() => {
    elapsedSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function updateTimerDisplay() {
  const hrs = Math.floor(elapsedSeconds / 3600).toString().padStart(2, '0');
  const mins = Math.floor((elapsedSeconds % 3600) / 60).toString().padStart(2, '0');
  const secs = (elapsedSeconds % 60).toString().padStart(2, '0');
  statusRight.textContent = `${hrs}:${mins}:${secs}`;
}

// ============================================
// Bottom Icon Buttons
// ============================================
document.getElementById('btn-about').addEventListener('click', () => showDialog('about'));
document.getElementById('btn-log').addEventListener('click', () => {
  document.getElementById('log-textarea').value = logEntries.join('\n');
  showDialog('log');
});

document.getElementById('btn-log-clear').addEventListener('click', () => {
  logEntries = [];
  document.getElementById('log-textarea').value = '';
});

// Hash calculation (Ctrl+H or via checkmark click)
isoCheck.addEventListener('click', async () => {
  if (!selectedIso) return;
  showDialog('hash');
  document.getElementById('hash-dialog-title').textContent = selectedIso.name;
  document.getElementById('hash-md5').value = 'Computing...';
  document.getElementById('hash-sha1').value = 'Computing...';
  document.getElementById('hash-sha256').value = 'Computing...';

  const hashes = await window.rufus.calculateHashes(selectedIso.path);
  if (hashes && !hashes.error) {
    document.getElementById('hash-md5').value = hashes.md5;
    document.getElementById('hash-sha1').value = hashes.sha1;
    document.getElementById('hash-sha256').value = hashes.sha256;
    document.getElementById('hash-sha512').value = hashes.sha512;
  } else {
    document.getElementById('hash-md5').value = 'Error computing hash';
    document.getElementById('hash-sha1').value = 'Error computing hash';
    document.getElementById('hash-sha256').value = 'Error computing hash';
  }
});

document.getElementById('btn-hash-ok').addEventListener('click', () => hideAllDialogs());

// ============================================
// Download ISO Dialog
// ============================================
document.getElementById('btn-dl-download').addEventListener('click', () => {
  hideAllDialogs();
  log('ISO download is not supported on Linux (use browser to download ISOs)');
});

document.getElementById('btn-dl-back').addEventListener('click', () => {
  hideAllDialogs();
});

// ============================================
// Dialog Helpers
// ============================================
function showDialog(name) {
  dialogOverlay.style.display = 'flex';
  hideAllDialogWindows();
  switch (name) {
    case 'download': dialogDownload.style.display = ''; break;
    case 'winux': dialogWinux.style.display = ''; break;
    case 'wtg': dialogWtg.style.display = ''; break;
    case 'hash': dialogHash.style.display = ''; break;
    case 'confirm': dialogConfirm.style.display = ''; break;
    case 'about': dialogAbout.style.display = ''; break;
    case 'log': dialogLog.style.display = ''; break;
  }
}

function hideAllDialogs() {
  dialogOverlay.style.display = 'none';
  hideAllDialogWindows();
}

function hideAllDialogWindows() {
  dialogDownload.style.display = 'none';
  dialogWinux.style.display = 'none';
  if (dialogWtg) dialogWtg.style.display = 'none';
  dialogHash.style.display = 'none';
  dialogConfirm.style.display = 'none';
  dialogAbout.style.display = 'none';
  dialogLog.style.display = 'none';
}

// Close buttons
document.querySelectorAll('.dialog-close-btn').forEach(btn => {
  btn.addEventListener('click', () => hideAllDialogs());
});

document.querySelectorAll('.dialog-btn[data-close]').forEach(btn => {
  btn.addEventListener('click', () => hideAllDialogs());
});

// ============================================
// Save button (next to device)
// ============================================
document.getElementById('btn-save-device').addEventListener('click', () => {
  log('Save to VHD is not supported in this version');
});

// ============================================
// Settings button
// ============================================
document.getElementById('btn-settings').addEventListener('click', () => {
  log('Settings panel would open here');
});

// ============================================
// Update button
// ============================================
document.getElementById('btn-update').addEventListener('click', () => {
  log('Check for updates: This is a Linux replica, updates are handled via package manager.');
});

// ============================================
// Helper Functions
// ============================================
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

// ============================================
// Initialize
// ============================================
log('Rufus 3.21.0 (Linux Replica)');
log('Application started');

// Report missing helper programs up front, so the log explains an operation
// that cannot work instead of failing with a cryptic error.
window.rufus.checkTools().then(({ missing, windowsToGo }) => {
  if (missing && missing.length) {
    log(`WARNING: missing tools: ${missing.join(', ')}`);
  }
  if (windowsToGo && windowsToGo.missing && windowsToGo.missing.length) {
    log(`Windows To Go needs: ${windowsToGo.missing.join(', ')} (pacman -S wimlib hivex)`);
  }
});

// Start the timer on launch
elapsedSeconds = 0;
startTimer();

// Initial state
updateUIForBootSelection(bootSelect.value);
setProgress(0, 'READY', false);
