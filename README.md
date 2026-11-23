# OpenCreator Commander

**A powerful file manager and system management interface for FlashForge Creator 5.**

OpenCreator Commander brings a familiar desktop-style file management experience to the FlashForge Creator 5, combining filesystem browsing, file editing, an integrated SSH terminal, customizable interface settings, and multiple layers of read-only protection.

Designed as an independent OpenCreator plugin, it provides direct access to the printer's filesystem through a clean, responsive web interface.

---

## Features

### 📁 File Explorer

A full-featured filesystem explorer with access to the printer's filesystem.

- Browse directories and files throughout the filesystem.
- Navigate folders with a familiar file-manager interface.
- Create new directories.
- Upload files.
- Rename files and directories.
- Move files and directories.
- Delete files and directories.
- View file and directory protection status.
- Select items and access contextual actions.
- Visual distinction between protected and writable items.

The Explorer is designed to make filesystem management straightforward while helping prevent accidental changes to critical system files.

### 📝 Integrated File Editor

Edit text-based configuration files and scripts directly from the browser.

- Open and edit files without an external editor.
- Read-only mode for protected files.
- Save changes directly to the printer.
- Clear protection status indicators.
- Dedicated warning for permanently protected system files.
- Resizable and movable editor window.
- Editor window geometry is saved and restored across sessions and printer reboots.

Protected files cannot be saved through the Commander editor.

### ⌨️ Integrated SSH Terminal

A built-in terminal provides direct command-line access to the printer.

- Interactive SSH shell.
- Keyboard input and terminal focus support.
- Execute system commands without opening a separate SSH client.
- Convenient access alongside the Explorer.

The terminal operates as a normal SSH session. Commander-level read-only protection does not automatically restrict commands executed through the shell.

### 🛡️ Read-Only Protection System

One of the core features of OpenCreator Commander is its filesystem protection system.

Protection is enforced by the backend, not just by hiding or disabling interface controls.

#### Custom protection

Users can protect and unprotect files and directories directly from the Explorer.

- Enable read-only protection on individual files.
- Protect entire directories.
- Protection automatically applies to all descendants.
- Remove custom protection when needed.
- Protection settings persist across printer reboots.
- Custom protection is stored separately from the plugin configuration.

The backend checks filesystem operations before allowing modifications, preventing protected content from being changed through the Explorer and editor APIs.

Protected operations include:

- File and directory creation inside protected locations.
- Uploading files.
- Editing and saving files.
- Renaming and moving files or directories.
- Deleting files and directories.
- Changing permissions.

#### System protection: `/usr/prog/`

The `/usr/prog/` directory is treated as a protected system area inside Commander.

- The directory and its descendants are read-only through the Commander filesystem interface.
- A warning is displayed when entering the protected directory.
- Protected items have a distinct visual appearance.
- Protection cannot be removed through the custom protection controls.

This helps prevent accidental modifications to important printer software.

#### Permanent protection: `app_startup.sh`

`/usr/prog/app_startup.sh` receives an additional level of protection.

It is a permanently protected system file and cannot be unlocked through Commander.

**Protection characteristics:**

- Always marked as protected.
- Dedicated red visual indicator.
- Editor opens in read-only mode.
- Save operations are disabled.
- No custom unprotect action is available.
- Backend protection cannot be overridden through the normal Commander API.
- The file is additionally protected at filesystem level using the Linux immutable attribute (`chattr +i`).

The immutable attribute prevents normal modifications, deletion, renaming and permission changes, including attempts made by root, until the attribute is deliberately removed.

This protection is independent of Commander and remains effective when using the SSH terminal.

> **Important:** The immutable attribute must be temporarily removed before a legitimate firmware update that needs to replace or modify this file. It can then be re-enabled after the update. A privileged administrator can deliberately remove the attribute, so this is a strong safeguard against accidental or ordinary modifications, not protection against a fully compromised system.

### 🎨 Settings and Customization

The Settings tab allows users to personalize the Commander interface without modifying its core configuration.

#### Custom colors

Configure the visual appearance of filesystem protection states:

- **RW:** Writable files and directories.
- **Custom RO:** User-protected files and directories.
- **System RO:** System-protected files and directories.
- **Permanent system file:** Always uses its dedicated red appearance.

Colors can be selected using color pickers and previewed immediately.

#### Font sizes

Adjust interface typography:

- General text.
- Labels.
- Buttons.

Changes are applied live in the interface, with a preview before saving.

#### Persistent settings

- Save customized settings to the printer.
- Restore default settings.
- Settings survive browser sessions and printer reboots.
- UI preferences are stored separately from protection rules and plugin configuration.

The permanent `app_startup.sh` warning color cannot be overridden by user customization.

### 🗑️ Safe Deletion Confirmation

Deletion operations include explicit confirmation warnings.

For files, the confirmation explains that deletion is permanent and cannot be undone.

For directories, the warning explicitly states that **all contents will be deleted**, including subdirectories and files.

This helps reduce the risk of accidental data loss.

### 🔐 Authentication

Commander provides an authenticated interface before granting access to its management features.

Optional credential remembering makes repeated access more convenient.

---

## Interface Overview

OpenCreator Commander is organized into three main sections:

| Section | Purpose |
|---|---|
| **Explorer** | Browse and manage the printer filesystem |
| **Terminal** | Execute commands through an integrated SSH shell |
| **Settings** | Customize colors and interface font sizes |

The interface uses visual indicators to make protection states immediately recognizable.

### Protection color scheme

| State | Appearance | Meaning |
|---|---|---|
| RW | Neutral | Writable |
| Custom RO | Orange | Protected by the user |
| System RO | Orange | Protected system area |
| Permanent RO | Red | Permanently protected system file |

The permanent protection of `app_startup.sh` takes precedence over all user-configurable colors.

---

## Storage and Persistence

Commander keeps its data separate from the printer's existing OpenCreator configuration.

Main locations:

| Path | Purpose |
|---|---|
| `/usr/data/opencreator/plugins/opencreator-commander/` | Plugin files |
| `/usr/data/opencreator/commander/config.json` | Plugin configuration |
| `/usr/data/opencreator/commander/protected.json` | Custom read-only protection rules |
| `/usr/data/opencreator/commander/settings.json` | User interface preferences |
| `/usr/data/opencreator/commander/editor-window.json` | Editor window geometry |

User preferences and custom protection rules are stored on the printer, not just in the browser.

---

## Design Principles

OpenCreator Commander follows a few important principles:

- **Safety first:** protect critical system files against accidental modifications.
- **Independent operation:** provide filesystem management without depending on an external host.
- **Persistent configuration:** preserve user settings across sessions and reboots.
- **Clear visual feedback:** make writable and protected states easy to identify.
- **Separation of concerns:** keep interface preferences, custom protection rules and plugin configuration independent.
- **Direct access:** provide Explorer, editor and terminal functionality in one interface.

---

## Installation

Install OpenCreator Commander directly through the OpenCreator Plugin Manager or via SSH:

```bash
oc-plugin install https://github.com/pappicio/opencreator-commander.git
```

Once installation is complete, the plugin starts its web interface on port `8088`.

### Accessing the Web Interface

Open a browser on any device connected to the same local network as the printer and navigate to:

`http://PRINTER_IP:8088`

Replace `PRINTER_IP` with the current IP address of your FlashForge Creator 5.

For example:

`http://192.168.1.194:8088`

The server listens on all network interfaces, so `127.0.0.1` is only suitable when accessing the interface directly from the printer itself.

OpenCreator Commander is designed to run as an OpenCreator plugin on the FlashForge Creator 5.

The plugin uses the printer's local filesystem and runs its own web interface and backend service.

---

## Important Security Notes

OpenCreator Commander provides application-level read-only protection for filesystem operations performed through its Explorer and editor APIs.

The `/usr/prog/app_startup.sh` file has additional filesystem-level protection through the Linux immutable attribute.

These mechanisms serve different purposes:

- **Commander protection** controls operations performed through the plugin.
- **Filesystem immutable protection** protects the designated startup file independently of the Commander interface.

The integrated SSH terminal remains a privileged command-line environment. Custom Commander protection rules do not restrict direct shell commands.

Always exercise care when modifying printer system files.

---

## Project

**OpenCreator Commander**  
An independent filesystem management and protection plugin for the FlashForge Creator 5.

Built to make printer filesystem management more convenient, customizable and safer.
