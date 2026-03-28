const { execSync, exec } = require('child_process');

/**
 * List all removable USB drives using lsblk
 */
function listUsbDrives() {
  return new Promise((resolve, reject) => {
    exec('lsblk -o NAME,RM,TRAN,TYPE,SIZE,LABEL,MOUNTPOINT,FSTYPE,MODEL,VENDOR,HOTPLUG -J -b', (err, stdout, stderr) => {
      if (err) {
        // If lsblk fails, return empty
        resolve([]);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const devices = data.blockdevices || [];
        
        const usbDrives = devices.filter(d => {
          const isRemovable = d.rm === true || d.rm === '1' || d.rm === 1;
          const isUsb = d.tran === 'usb';
          const isDisk = d.type === 'disk';
          const isHotplug = d.hotplug === true || d.hotplug === '1' || d.hotplug === 1;
          return isDisk && (isUsb || (isRemovable && isHotplug));
        });

        const result = usbDrives.map(drive => {
          const sizeBytes = parseInt(drive.size) || 0;
          const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(1);
          const label = drive.label || '';
          const model = (drive.model || '').trim();
          const vendor = (drive.vendor || '').trim();
          const devicePath = '/dev/' + drive.name;

          // Get partitions
          const partitions = (drive.children || []).map(part => ({
            name: part.name,
            path: '/dev/' + part.name,
            size: part.size,
            label: part.label || '',
            mountpoint: part.mountpoint || '',
            fstype: part.fstype || ''
          }));

          // Get the label from the first partition if drive has no label
          const displayLabel = label || (partitions.length > 0 ? partitions[0].label : '') || model || 'NO_LABEL';
          const fstype = (partitions.length > 0 ? partitions[0].fstype : drive.fstype) || '';

          return {
            name: drive.name,
            path: devicePath,
            sizeBytes: sizeBytes,
            sizeGB: sizeGB,
            sizeDisplay: `${sizeGB} GB`,
            label: displayLabel,
            model: model,
            vendor: vendor,
            fstype: fstype,
            partitions: partitions,
            displayName: `${displayLabel} (${devicePath}) [${sizeGB} GB]`
          };
        });

        resolve(result);
      } catch (parseErr) {
        resolve([]);
      }
    });
  });
}

module.exports = { listUsbDrives };
