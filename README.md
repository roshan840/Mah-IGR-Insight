# Mah-IGR-Insight (IGR Maharashtra Automation Pro)

**Automate IGR Maharashtra land record scraping with this premium Chrome Extension (MV3). Bulk extract Index II data, auto-handle pagination, and export clean CSVs. Features a sleek glassmorphic UI, live progress logs, and adjustable delays for slow servers. Scrape property details, party names, and financials with ease. Fast and reliable.**


---

## 🚀 Features

- ✅ Bulk downloads all 10 documents per page sequentially
- ✅ Automatically navigates to next page after completing current page  
- ✅ Handles slow IGR government server (45-second popup timeout)
- ✅ Saves PDFs with descriptive filenames (DocNo + Name + Date)
- ✅ Live progress logs in popup
- ✅ CSV export of all scraped document metadata
- ✅ Incognito tab support
- ✅ Configurable delay between downloads

---

## 📦 Installation

1. Clone or download this repository
2. Open Chrome → go to `chrome://extensions`
3. Enable **Developer Mode** (top right toggle)
4. Click **"Load unpacked"**
5. Select the `igr-auto-pdf` folder
6. Pin the extension to your toolbar

---

## 🔧 Usage

1. Go to [IGR Maharashtra Free Search](https://freesearchigrservice.maharashtra.gov.in/)
2. Perform your search — wait for results table to load
3. Click the **IGR Auto PDF** extension icon
4. Click **"Start Extraction"**
5. PDFs are saved to your `Downloads/IGR_PDFs/` folder

> ⚠️ **Important:** After reloading the extension, always refresh the IGR page before starting.

---

## 📁 File Structure

```
igr-auto-pdf/
├── manifest.json     # Extension config (MV3)
├── background.js     # Service worker: queue management, PDF generation
├── content.js        # Page scraper: button detection, pagination
├── popup.html        # Extension popup UI
├── popup.js          # Popup logic: start/stop/export
└── icons/            # Extension icons
```

---

## ⚙️ How It Works

```
User clicks Start
    ↓
content.js scans RegistrationGrid for IndexII buttons
    ↓
Sends queue to background.js (10 items per page)
    ↓
background.js clicks each button → waits up to 45s for popup
    ↓
Chrome Debugger API → Page.printToPDF → saves to Downloads/IGR_PDFs/
    ↓
After all 10: clicks next page → rescans → repeat
```

---

## 🛡️ Permissions Used

| Permission | Reason |
|---|---|
| `tabs` | Detect popup windows |
| `scripting` | Click buttons on the IGR page |
| `debugger` | Generate PDF from popup tab |
| `downloads` | Save PDF files |
| `storage` | Save state and configuration |

---

## ⚠️ Disclaimer

This extension is for **personal/research use only**. Use responsibly and in accordance with IGR Maharashtra's terms of service. The extension only reads publicly available search results.

---

## 📄 License

MIT License — feel free to use, modify, and distribute.
