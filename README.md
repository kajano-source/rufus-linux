# rufus-linux

A Linux-native replica of the [Rufus](https://rufus.ie) USB formatting utility, written in Electron.

Write an ISO to a USB drive, format a drive as plain storage, or build real
**Windows To Go** media - without leaving the desktop.

> Not affiliated with Rufus / Akeo Consulting. This is an independent
> reimplementation; Rufus itself is GPL-3.0 and this project is GPL-3.0 as well.

## What it does

| Feature | Status |
| --- | --- |
| Write an ISO image to a USB drive (`dd`, resumable progress) | Working |
| Format a USB drive (FAT32 / exFAT / NTFS / ext2 / ext4) with a volume label | Working |
| Hash an ISO (MD5, SHA-1, SHA-256, SHA-512) | Working |
| Removable drive detection via `lsblk` | Working |
| **Windows To Go** (apply an Enterprise/Education image + build a boot configuration) | Working, needs `wimlib` and `hivex` |
| Persistent partition size slider | UI only, not implemented |
| ISO download, Save to VHD, bad block check | Not implemented |

## Windows To Go

Selecting **Image option → Windows To Go** no longer performs a plain copy of
the ISO. Rufus creates portable Windows media like this:

1. The ISO is mounted read-only and `sources/install.wim` is inspected.
2. The **Enterprise** or **Education** image is selected - the only editions
   Microsoft permits to run from removable media - and its expanded size is
   checked against the target drive.
3. The stick is repartitioned as GPT: a 260 MiB FAT32 EFI system partition plus
   one NTFS partition labelled `WINDOWS TO GO`.
4. The image is applied directly onto the NTFS volume with `wimlib-imagex`.
5. The EFI partition is built from the image's own Microsoft-signed
   `bootmgfw.efi` (plus a removable-media `EFI/BOOT/BOOTX64.EFI` fallback), and a
   BCD is generated with `hivexsh` from the `BCD-Template` shipped inside the
   image. The generated store boots `\WINDOWS\system32\winload.efi` straight out
   of the applied image and disables the Windows Recovery Environment.
6. A `Windows/Panther/Unattend.xml` answer file is written so the first boot
   skips the online account screen.

If the media turns out to be unusable the operation aborts **before the drive is
erased**.

Extra packages needed for this feature only:

```sh
sudo pacman -S wimlib hivex     # Arch
sudo apt install wimtools hivex  # Debian/Ubuntu
```

## Privileges

Writing to a block device needs root. Rufus runs **one `pkexec` transaction per
operation**: the whole pipeline (unmount, wipe, partition, format, copy, boot
configuration) happens inside a single generated script, so the polkit agent
asks for your password **once**, not once per command. Polkit caches the
authorisation for a few minutes, so consecutive operations normally do not prompt
at all.

Cancellation is cooperative: the privileged script owns the `dd`/`wimlib`
processes and polls a flag file that the unprivileged renderer writes, so
`CANCEL` really stops the transfer instead of orphaning it.

## Installing

### Arch (AUR)

```sh
git clone https://aur.archlinux.org/rufus-linux.git
cd rufus-linux && makepkg -si
```

Or with the prebuilt AppImage (`rufus-linux-bin`).

### From source

```sh
git clone https://github.com/kajano-source/rufus-linux
cd rufus-linux
npm install
npm start          # run
npm run dist       # build an AppImage into dist/
npm test           # run the test suite
```

## Runtime requirements

`polkit` (`pkexec`), `util-linux`, `parted`, `dosfstools`, `ntfs-3g`,
`exfatprogs`, `e2fsprogs`, and - for Windows To Go - `wimlib` and `hivex`.
The app checks for missing tools at startup and reports them in the log instead
of failing mid-operation.

## Safety

* Only whole removable disk nodes (`/dev/sdX`, `/dev/mmcblkX`, `/dev/nvmeXnY`)
  are accepted as targets; partition nodes are rejected.
* Every operation unmounts the target first and restores nothing afterwards.
* Nothing is erased until the Windows image has been validated.
* All values that reach the privileged script are single-quoted, so filenames
  and labels cannot break out of the generated shell.

## Development

```
backend/
  shell.js          shell quoting, tool discovery, device guards
  privilege.js      single-elevation runner (one pkexec per operation)
  iso-writer.js     ISO -> USB pipeline
  formatter.js      format a drive as a single filesystem
  windows-to-go.js  Windows To Go pipeline
  wtg-bcd.js        BCD generation (pure, unit tested)
  usb-detect.js     lsblk based drive enumeration
src/                renderer (HTML/CSS/JS)
test/               node:test suite; no root or USB drive required
```

`npm test` checks shell quoting, the device guards, every generated script
(`bash -n`), the 88-byte BCD device records against the layout `bcdedit`
produces, and the Windows image parsing/edition selection.

## License

GPL-3.0
