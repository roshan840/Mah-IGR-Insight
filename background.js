const IGR_URL_PATTERN = /^https:\/\/freesearchigrservice\.maharashtra\.gov\.in\//i;
const IGR_URL_GLOB = 'https://freesearchigrservice.maharashtra.gov.in/*';

/** Gap after closing popup before clicking the next Index II row */
const ROW_GAP_AFTER_SUCCESS_MS = 300;
/** Poll interval while waiting for popup HTML to be scrape-ready */
const POPUP_SCRAPE_POLL_MS = 350;
const POPUP_SCRAPE_MAX_MS = 30000;
const POPUP_OPEN_TIMEOUT_MS = 45000;
const CLICK_RETRY_MS = 500;

let downloadQueue = [];
let queuedIds = new Set();
let isProcessing = false;
let sourceTabId = null;
let batchTotal = 0;
let processedCount = 0;
let cachedDelay = null;

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.configDelay) cachedDelay = null;
});

chrome.runtime.onInstalled.addListener(() => injectAllIgrTabs());
chrome.runtime.onStartup.addListener(() => injectAllIgrTabs());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && IGR_URL_PATTERN.test(tab.url)) {
        injectIntoTab(tabId);
    }
});

async function injectAllIgrTabs() {
    const tabs = await chrome.tabs.query({ url: IGR_URL_GLOB });
    for (const tab of tabs) {
        if (tab.id) await injectIntoTab(tab.id);
    }
}

async function injectIntoTab(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['content.js']
        });
    } catch (err) {
        console.warn('[IGR] Could not inject into tab', tabId, err.message);
    }
}

async function startExtractionOnTab(tabId) {
    await injectIntoTab(tabId);
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'start' });
        return true;
    } catch (err) {
        sendLog('Could not reach the IGR tab. Click the results tab and try Start again.', 'warn');
        return false;
    }
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action === 'startExtraction' && message.tabId) {
        startExtractionOnTab(message.tabId);
        return;
    }

    if (message.action === 'injectTab' && message.tabId) {
        injectIntoTab(message.tabId);
        return;
    }
    if (message.action === 'enqueueDownloads') {
        const newLinks = message.links.filter((link) => {
            if (queuedIds.has(link.id)) return false;
            queuedIds.add(link.id);
            return true;
        });
        if (newLinks.length === 0) return;

        downloadQueue.push(...newLinks);
        batchTotal += newLinks.length;
        sourceTabId = sender.tab?.id ?? sourceTabId;

        if (!isProcessing) {
            isProcessing = true;
            processedCount = 0;
            processNext();
        }
        return;
    }

    if (message.action === 'triggerNextPage') {
        const tabId = sender.tab?.id;
        if (!tabId) return;
        setTimeout(async () => {
            await clickInMainWorld(tabId, '[data-scraper-id="next-page-btn"]');
            setTimeout(async () => {
                await injectIntoTab(tabId);
                chrome.tabs.sendMessage(tabId, { action: 'rescan' }).catch(() => { });
            }, 6000);
        }, 3000);
        return;
    }

    if (message.action === 'stop') {
        resetQueue();
        sendLog('Stopped by user.', 'warn');
    }
});

function resetQueue() {
    downloadQueue = [];
    queuedIds.clear();
    isProcessing = false;
    batchTotal = 0;
    processedCount = 0;
}

function scheduleNext(ms) {
    setTimeout(processNext, ms);
}

async function processNext() {
    if (downloadQueue.length === 0) {
        sendLog('✓ All documents processed!', 'success');
        isProcessing = false;
        batchTotal = 0;
        processedCount = 0;
        if (sourceTabId && (await tabExists(sourceTabId))) {
            chrome.tabs.sendMessage(sourceTabId, { action: 'pageFinished' }).catch(() => { });
        }
        return;
    }

    const linkInfo = downloadQueue.shift();
    processedCount += 1;

    if (batchTotal > 0) {
        const progress = Math.min(100, Math.round((processedCount / batchTotal) * 100));
        chrome.runtime.sendMessage({
            action: 'updateProgress',
            progress,
            current: processedCount,
            total: batchTotal
        }).catch(() => { });
    }

    sendLog(`Row ${linkInfo.index + 1}: Scraping (${processedCount}/${batchTotal})...`, 'info');

    try {
        if (!sourceTabId || !(await tabExists(sourceTabId))) {
            sendLog('Source tab closed. Stopping.', 'warn');
            resetQueue();
            return;
        }

        const selector = `[data-scraper-id="${linkInfo.id}"]`;
        sendLog(`Row ${linkInfo.index + 1}: Clicking document...`, 'info');

        const existingTabIds = new Set((await chrome.tabs.query({})).map((t) => t.id));

        let clicked = await clickInMainWorld(sourceTabId, selector);
        if (!clicked) {
            const backupSelector = `input[onclick*="ndexII$${linkInfo.index}"], a[onclick*="ndexII$${linkInfo.index}"], [onclick*="indexII$${linkInfo.index}"]`;
            sendLog(`Row ${linkInfo.index + 1}: Retrying with backup selector...`, 'warn');
            await sleep(CLICK_RETRY_MS);
            clicked = await clickInMainWorld(sourceTabId, backupSelector);
        }

        if (!clicked) {
            sendLog(`Row ${linkInfo.index + 1}: Button not found. Skipping.`, 'warn');
            scheduleNext(await getErrorDelay());
            return;
        }

        sendLog(`Row ${linkInfo.index + 1}: Waiting for popup...`, 'info');
        const newTab = await waitForNewTab(existingTabIds, POPUP_OPEN_TIMEOUT_MS);

        if (!newTab?.id) {
            sendLog(`Row ${linkInfo.index + 1}: No popup appeared. Skipping.`, 'warn');
            scheduleNext(await getErrorDelay());
            return;
        }

        const popupTabId = newTab.id;
        sendLog(`Row ${linkInfo.index + 1}: Extracting...`, 'info');
        const scrapedData = await scrapePopupWhenReady(popupTabId);

        let success = false;
        if (scrapedData) {
            await saveScrapedData({
                ...scrapedData,
                sourceFilename: linkInfo.filename,
                scrapedAt: new Date().toISOString()
            });
            sendLog(`Row ${linkInfo.index + 1}: ✓ Extracted!`, 'success');
            success = true;
        } else {
            sendLog(`Row ${linkInfo.index + 1}: Extraction failed.`, 'warn');
        }

        await closePopupTab(popupTabId);

        scheduleNext(success ? ROW_GAP_AFTER_SUCCESS_MS : await getErrorDelay());
    } catch (err) {
        sendLog(`Row ${linkInfo.index + 1} Error: ${err.message}`, 'warn');
        scheduleNext(await getErrorDelay());
    }
}

function hasScrapePayload(data) {
    return !!(
        data?.docNo
        || data?.barcode
        || data?.registrationDate
        || data?.date
        || data?.sellers?.length
        || data?.buyers?.length
    );
}

async function scrapePopupWhenReady(tabId) {
    const deadline = Date.now() + POPUP_SCRAPE_MAX_MS;
    while (Date.now() < deadline) {
        if (!(await tabExists(tabId))) return null;
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.status === 'complete') {
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: scrapeIndexIIPage
                });
                const data = results?.[0]?.result;
                if (hasScrapePayload(data)) return data;
            }
        } catch {
            /* tab may still be loading */
        }
        await sleep(POPUP_SCRAPE_POLL_MS);
    }
    return null;
}

async function closePopupTab(tabId) {
    if (tabId && (await tabExists(tabId))) {
        await chrome.tabs.remove(tabId).catch(() => { });
    }
}

function scrapeIndexIIPage() {
    const getX = (xpath, context = document) => {
        try {
            const node = document.evaluate(
                xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
            return node ? node.textContent.trim() : '';
        } catch {
            return '';
        }
    };

    const getXList = (xpath, context = document) => {
        try {
            const iterator = document.evaluate(
                xpath, context, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null
            );
            const results = [];
            let node = iterator.iterateNext();
            while (node) {
                results.push(node.textContent.trim());
                node = iterator.iterateNext();
            }
            return results;
        } catch {
            return [];
        }
    };

    const data = {};
    data.barcode = getX("//font[@face='3 of 9 Barcode']");

    const dateTag = Array.from(document.querySelectorAll('font'))
        .find((f) => /\d{2}-\d{2}-\d{4}/.test(f.textContent));
    data.date = dateTag ? dateTag.textContent.trim() : '';

    const getCleanVal = (search) => {
        const node = getX(`//*[self::td or self::p][contains(.,'${search}')]`);
        if (!node) return '';
        const parts = node.split(/[:\-]/);
        return parts.length > 1 ? parts.slice(1).join(':').trim() : node.replace(search, '').trim();
    };

    data.sro = getCleanVal('दुय्यम निबंधक');
    data.docNo = getCleanVal('दस्त क्रमांक');
    data.village = getCleanVal('गावाचे');

    const labelMap = [
        ['विलेखाचा प्रकार', 'docType'],
        ['मोबदला', 'consideration'],
        ['बाजारभाव', 'marketValue'],
        ['क्षेत्रफळ', 'area'],
        ['दस्तऐवज करुन दिल्याचा दिनांक', 'executedDate'],
        ['नोंदणी केल्याचा दिनांक', 'registrationDate'],
        ['अनुक्रमांक', 'indexBook'],
        ['मुद्रांक शुल्क', 'stampDuty'],
        ['नोंदणी शुल्क', 'regFee'],
        ['भू-मापन', 'propertyDesc']
    ];

    for (const row of document.querySelectorAll('table.tblmargin tr, table.grid tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        const label = cells[0].textContent.trim();
        const val = cells[1].textContent.trim();
        for (const [needle, key] of labelMap) {
            if (label.includes(needle)) data[key] = val;
        }
    }

    const cleanParty = (text) => text.replace(/^\d+\):\s*नाव:-/, '').replace(/^नाव:-/, '').trim();
    data.sellers = getXList("//tr[td[contains(.,'देणा')]]//table//tr//font")
        .map(cleanParty).filter((x) => x.length > 2);
    data.buyers = getXList("//tr[td[contains(.,'घेणा')]]//table//tr//font")
        .map(cleanParty).filter((x) => x.length > 2);

    return data;
}

async function saveScrapedData(record) {
    const data = await chrome.storage.local.get(['scrapedResults', 'pages']);
    const results = data.scrapedResults || [];
    results.push(record);
    await chrome.storage.local.set({ scrapedResults: results });
    chrome.runtime.sendMessage({
        action: 'updateStats',
        scraped: results.length,
        pages: data.pages || 0
    }).catch(() => { });
}

async function clickInMainWorld(tabId, selector) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: (sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                el.style.outline = '3px dashed #6366f1';
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
                for (const type of ['mousedown', 'mouseup']) {
                    el.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true }));
                }
                el.click();
                return true;
            },
            args: [selector]
        });
        return results?.some((r) => r.result === true) ?? false;
    } catch {
        return false;
    }
}

function waitForNewTab(existingTabIds, timeout = 45000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (tab) => {
            if (done) return;
            done = true;
            chrome.tabs.onCreated.removeListener(onCreated);
            clearTimeout(timer);
            resolve(tab);
        };
        const onCreated = (tab) => {
            if (tab.id && !existingTabIds.has(tab.id)) finish(tab);
        };
        const timer = setTimeout(() => finish(null), timeout);
        chrome.tabs.onCreated.addListener(onCreated);
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
            if (id === tabId && info.status === 'complete' && tab.url?.startsWith('http')) {
                finish(true);
            }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        const timer = setTimeout(() => finish(false), timeout);
        chrome.tabs.get(tabId, (tab) => {
            if (!chrome.runtime.lastError && tab?.status === 'complete' && tab.url?.startsWith('http')) {
                finish(true);
            }
        });
    });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Extra pause only after errors/skips (success path uses ROW_GAP_AFTER_SUCCESS_MS). */
async function getErrorDelay() {
    if (cachedDelay != null) return cachedDelay;
    const data = await chrome.storage.local.get(['configDelay']);
    cachedDelay = Math.max(0, data.configDelay ?? 0);
    return cachedDelay;
}

function sendLog(message, logType = 'info') {
    chrome.runtime.sendMessage({ action: 'log', message, logType }).catch(() => { });
}

async function tabExists(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return true;
    } catch {
        return false;
    }
}
