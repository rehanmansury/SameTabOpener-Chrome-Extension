# SameTabOpener Chrome Extension

A powerful Chrome extension for managing duplicate tabs, automatic tab reuse, and enhanced tab organization.

## Features

### 🔄 Tab Management
- **Duplicate Tab Detection**: Automatically detects and groups duplicate tabs by domain
- **Badge Counter**: Shows count of tabs with same domain as current active tab
- **Tab Alignment**: Sort and group tabs by domain for better organization
- **Quick Tab Navigation**: Click any tab in the duplicate list to focus it

### 🛡️ Close Protection
- **Domain-based Protection**: Add domains that require confirmation before closing
- **BeforeUnload Prevention**: Shows confirmation dialog before closing protected tabs
- **Easy Management**: Add/remove protected domains from the settings

### ⚡ Auto Refresh
- **Domain-based Refresh**: Set custom refresh intervals for specific domains
- **Flexible Timing**: Configure refresh intervals (minimum 10 seconds)
- **Edit Rules**: Easily modify existing refresh rules
- **Background Operation**: Refreshes tabs even when not in focus

### 🎯 Zendesk Integration
- **Smart Tab Reuse**: Automatically reuses existing Zendesk tabs
- **No-Reload Navigation**: Navigate within Zendesk without full page reloads
- **Ticket Detection**: Automatically detects and groups Zendesk ticket tabs

## Installation

### From Chrome Web Store
*(Coming soon)*

### Manual Installation
1. Download the latest release from [Releases](https://github.com/rehanmansury/SameTabOpener-Chrome-Extension/releases)
2. Unzip the downloaded file
3. Open Chrome and navigate to `chrome://extensions/`
4. Enable "Developer mode" (toggle in top right)
5. Click "Load unpacked"
6. Select the unzipped folder

## Usage

### Duplicate Tabs
1. Click the extension icon to open the popup
2. View all duplicate tabs grouped by domain
3. Click any tab to focus it
4. Use "×" to close individual tabs or entire groups
5. Click "Align by URL" to sort tabs alphabetically

### Close Protection
1. Go to Settings tab
2. Add domains to protect (e.g., `mail.google.com`)
3. When closing a protected tab, you'll see a confirmation dialog

### Auto Refresh
1. Go to Settings tab
2. Scroll to "Auto Refresh Rules"
3. Add a domain and refresh interval
4. Tabs matching that domain will refresh automatically

## Screenshots

*(Add screenshots here)*

## Development

### Building
No build process required - the extension uses vanilla JavaScript.

### File Structure
```
SameTabOpener-V1.1/
├── manifest.json          # Extension manifest
├── popup.html             # Popup UI
├── javascripts/
│   ├── background.js      # Background service worker
│   ├── popup.js          # Popup logic
│   └── protectClose.js   # Content script
└── icons/                # Extension icons
```

### Contributing
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Changelog

### v1.3
- Added duplicate tab detection and management
- Implemented close protection feature
- Added auto-refresh functionality
- Enhanced Zendesk tab reuse with no-reload navigation
- Improved UI with better tab organization

## Support

For issues and feature requests, please use the [Issues](https://github.com/rehanmansury/SameTabOpener-Chrome-Extension/issues) page.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Author

Created by [Rehan Mansury](https://github.com/rehanmansury)

---

**Note**: This extension is designed to improve tab management efficiency while maintaining privacy and security. No data is sent to external servers.
