let downloadQueue = [];
let isProcessing = false;
let sourceTabId = null;
let batchTotal = 0;

// ─── Message Hub ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === 'enqueueDownloads') {
        const newLinks = message.links.filter(
            link => !downloadQueue.some(q => q.id === link.id)
        );
        downloadQueue = [...downloadQueue, ...newLinks];
        batchTotal = downloadQueue.length;
        sourceTabId = sender.tab.id;
        console.log(`[IGR] Queue: ${downloadQueue.length} items from Tab ${sourceTabId}`);

        if (!isProcessing && downloadQueue.length > 0) {
            isProcessing = true;
            processNext();
        }
    }

    if (message.action === 'triggerNextPage') {
        if (sender.tab?.id) {
            const tabId = sender.tab.id;
            setTimeout(async () => {
                console.log('[IGR] Clicking next-page link...');
                await clickInMainWorld(tabId, '[data-scraper-id="next-page-btn"]');
                setTimeout(() => {
                    console.log('[IGR] Sending rescan to content script...');
                    chrome.tabs.sendMessage(tabId, { action: 'rescan' }).catch(() => { });
                }, 6000);
            }, 3000);
        }
    }

    if (message.action === 'stop') {
        downloadQueue = [];
        isProcessing = false;
        sendLog("Stopped by user.", "warn");
    }
});

// ─── Main Loop ────────────────────────────────────────────────────────────────
async function processNext() {
    if (downloadQueue.length === 0) {
        sendLog("✓ All documents processed!", "success");
        isProcessing = false;
        if (sourceTabId && await checkTabExists(sourceTabId)) {
            chrome.tabs.sendMessage(sourceTabId, { action: 'pageFinished' }).catch(() => { });
        }
        return;
    }

    const linkInfo = downloadQueue.shift();

    const completed = batchTotal - downloadQueue.length;
    const progress = Math.round((completed / batchTotal) * 100);
    chrome.runtime.sendMessage({
        action: 'updateProgress',
        progress: progress,
        current: completed,
        total: batchTotal
    }).catch(() => { });

    sendLog(`Row ${linkInfo.index + 1}: Scraping (${completed}/${batchTotal})...`, "info");

    try {
        if (!sourceTabId || !(await checkTabExists(sourceTabId))) {
            sendLog("Source tab closed. Stopping.", "warn");
            isProcessing = false;
            return;
        }

        // ── STEP 1: Click the IndexII button
        const selector = `[data-scraper-id="${linkInfo.id}"]`;

        sendLog(`Row ${linkInfo.index + 1}: Clicking document...`, "info");

        let clicked = await clickInMainWorld(sourceTabId, selector);
        if (!clicked) {
            // Backup selector if the ID was lost during an AJAX refresh
            const backupSelector = `input[onclick*="ndexII$${linkInfo.index}"], a[onclick*="ndexII$${linkInfo.index}"], [onclick*="indexII$${linkInfo.index}"]`;
            sendLog(`Row ${linkInfo.index + 1}: Retrying with backup selector...`, "warn");
            await sleep(2000);
            clicked = await clickInMainWorld(sourceTabId, backupSelector);
        }

        if (!clicked) {
            sendLog(`Row ${linkInfo.index + 1}: Button not found. Skipping.`, "warn");
            setTimeout(processNext, 2000);
            return;
        }

        // ── STEP 2: Wait for popup
        sendLog(`Row ${linkInfo.index + 1}: Waiting for popup...`, "info");
        const newTab = await waitForNewTab(45000);

        if (!newTab) {
            sendLog(`Row ${linkInfo.index + 1}: No popup appeared. Skipping.`, "warn");
            setTimeout(processNext, await getDelay());
            return;
        }

        // ── STEP 3: Scrape
        sendLog(`Row ${linkInfo.index + 1}: Document opened. Extracting...`, "info");
        const loaded = await waitForTabReady(newTab.id, 30000);

        if (loaded) {
            await sleep(4000); // 4s wait for slow IGR document rendering
            const results = await chrome.scripting.executeScript({
                target: { tabId: newTab.id },
                func: scrapeIndexIIPage
            });

            if (results && results[0] && results[0].result) {
                const scrapedData = results[0].result;
                await saveScrapedData({
                    ...scrapedData,
                    sourceFilename: linkInfo.filename,
                    scrapedAt: new Date().toISOString()
                });
                sendLog(`Row ${linkInfo.index + 1}: ✓ Extracted!`, "success");
            } else {
                sendLog(`Row ${linkInfo.index + 1}: Extraction failed.`, "warn");
            }
        }

        if (await checkTabExists(newTab.id)) {
            await chrome.tabs.remove(newTab.id).catch(() => { });
        }

        const delay = await getDelay();
        setTimeout(processNext, delay);

    } catch (err) {
        sendLog(`Row ${linkInfo.index + 1} Error: ${err.message}`, "warn");
        const delay = await getDelay();
        setTimeout(processNext, delay);
    }
}

function scrapeIndexIIPage() {
    const getX = (xpath, context = document) => {
        try {
            const result = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            return result ? result.textContent.trim() : "";
        } catch (e) { return ""; }
    };

    const getXList = (xpath, context = document) => {
        try {
            const iterator = document.evaluate(xpath, context, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
            const results = [];
            let node = iterator.iterateNext();
            while (node) {
                results.push(node.textContent.trim());
                node = iterator.iterateNext();
            }
            return results;
        } catch (e) { return []; }
    };

    const data = {};

    // 1. Header Info
    data.barcode = getX("//font[@face='3 of 9 Barcode']");
    const fontTags = Array.from(document.querySelectorAll('font'));
    const dateTag = fontTags.find(f => /\d{2}-\d{2}-\d{4}/.test(f.textContent));
    data.date = dateTag ? dateTag.textContent.trim() : "";

    // Robust extraction for SRO, Doc No, Village
    const getCleanVal = (search) => {
        const node = getX(`//*[self::td or self::p][contains(.,'${search}')]`);
        if (!node) return "";
        const parts = node.split(/[:\-]/);
        return (parts.length > 1) ? parts.slice(1).join(':').trim() : node.replace(search, "").trim();
    };

    data.sro = getCleanVal('दुय्यम निबंधक');
    data.docNo = getCleanVal('दस्त क्रमांक');
    data.village = getCleanVal('गावाचे');

    // 2. Main Table Data (Key-Value)
    const rows = document.querySelectorAll("table.tblmargin tr, table.grid tr");
    rows.forEach(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 2) {
            const label = cells[0].textContent.trim();
            const val = cells[1].textContent.trim();
            if (label.includes("विलेखाचा प्रकार")) data.docType = val;
            if (label.includes("मोबदला")) data.consideration = val;
            if (label.includes("बाजारभाव")) data.marketValue = val;
            if (label.includes("क्षेत्रफळ")) data.area = val;
            if (label.includes("दस्तऐवज करुन दिल्याचा दिनांक")) data.executedDate = val;
            if (label.includes("नोंदणी केल्याचा दिनांक")) data.registrationDate = val;
            if (label.includes("अनुक्रमांक")) data.indexBook = val;
            if (label.includes("मुद्रांक शुल्क")) data.stampDuty = val;
            if (label.includes("नोंदणी शुल्क")) data.regFee = val;
            if (label.includes("भू-मापन")) data.propertyDesc = val;
        }
    });

    const cleanParty = (text) => text.replace(/^\d+\):\s*नाव:-/, '').replace(/^नाव:-/, '').trim();
    data.sellers = getXList("//tr[td[contains(.,'देणा')]]//table//tr//font", document).map(cleanParty).filter(x => x.length > 2);
    data.buyers = getXList("//tr[td[contains(.,'घेणा')]]//table//tr//font", document).map(cleanParty).filter(x => x.length > 2);

    return data;
}

async function saveScrapedData(record) {
    const data = await chrome.storage.local.get(['scrapedResults', 'pages']);
    const results = data.scrapedResults || [];
    results.push(record);
    await chrome.storage.local.set({ scrapedResults: results });
    chrome.runtime.sendMessage({ action: 'updateStats', scraped: results.length, pages: data.pages || 0 }).catch(() => { });
}

async function clickInMainWorld(tabId, selector) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: (sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.style.outline = "3px dashed #6366f1";
                    el.scrollIntoView({ behavior: 'auto', block: 'center' });

                    // BRUTE FORCE CLICK SEQUENCE
                    const trigger = (type) => {
                        const ev = new MouseEvent(type, { view: window, bubbles: true, cancelable: true });
                        el.dispatchEvent(ev);
                    };

                    trigger('mousedown');
                    trigger('mouseup');
                    el.click(); // Standard click as fallback
                    return true;
                }
                return false;
            },
            args: [selector]
        });
        return results?.some(r => r.result === true) ?? false;
    } catch (err) { return false; }
}

function waitForNewTab(timeout = 45000) {
    return new Promise((resolve) => {
        let done = false;
        const listener = (tab) => {
            if (done) return;
            done = true;
            chrome.tabs.onCreated.removeListener(listener);
            clearTimeout(timer);
            resolve(tab);
        };
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            chrome.tabs.onCreated.removeListener(listener);
            resolve(null);
        }, timeout);
        chrome.tabs.onCreated.addListener(listener);
    });
}

function waitForTabReady(tabId, timeout = 25000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            resolve(result);
        };
        const onUpdated = (id, info, tab) => {
            if (id === tabId && info.status === 'complete' && tab.url?.startsWith('http')) finish(true);
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        const timer = setTimeout(() => finish(false), timeout);
        chrome.tabs.get(tabId, (tab) => {
            if (!chrome.runtime.lastError && tab?.status === 'complete' && tab.url?.startsWith('http')) finish(true);
        });
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function getDelay() {
    const data = await chrome.storage.local.get(['configDelay']);
    return Math.max(2000, data.configDelay || 3000);
}
function sendLog(message, logType = 'info') {
    chrome.runtime.sendMessage({ action: 'log', message, logType }).catch(() => { });
}
async function checkTabExists(tabId) {
    try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}
