// Run in all frames (IGR sometimes uses frames for the grid)
console.log("IGR Scraper: Content Script Loaded in " + (window === window.top ? "Top Frame" : "Sub-frame"));

let extractionConfig = {
    // Robust selector covering variations seen on IGR
    linkSelector: "input[value*='ndex'], input[onclick*='ndexII'], a[onclick*='ndexII'], [id*='btnIndex']",
    highlightColor: "3px solid #6366f1",
    delay: 3000
};

function sendLog(message, logType = 'info') {
    if (isContextValid()) {
        chrome.runtime.sendMessage({ action: 'log', message, logType }).catch(() => { });
    }
}

function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}

function checkAndRun() {
    if (!isContextValid()) return;
    chrome.storage.local.get(['isRunning', 'urls', 'pages'], (data) => {
        if (data.isRunning) {
            scrapeWithRetry(data.urls || [], data.pages || 0);
        }
    });
}

async function scrapeWithRetry(existingUrls, pagesCount, attempt = 1) {
    if (!isContextValid()) return;

    const grid = document.getElementById('RegistrationGrid');
    const allLinks = Array.from(document.querySelectorAll(extractionConfig.linkSelector))
        .filter(el => {
            const val = (el.value || el.innerText || '').toLowerCase();
            const onClick = (el.getAttribute('onclick') || '').toLowerCase();
            return val.includes('index') || onClick.includes('indexii');
        });

    if (allLinks.length === 0) {
        if (attempt < 5) {
            console.log(`IGR Scraper: No buttons yet (Attempt ${attempt}). Grid found: ${!!grid}. Retrying...`);
            setTimeout(() => scrapeWithRetry(existingUrls, pagesCount, attempt + 1), 2000);
            return;
        }
        // Only log "None found" in the top frame to avoid spam
        if (window === window.top) sendLog("No documents found on this page.", "warn");
        return;
    }

    console.log(`IGR Scraper: Found ${allLinks.length} documents on this page.`);
    sendLog(`Found ${allLinks.length} documents. Starting extraction...`, "success");
    scrapePage(existingUrls, pagesCount, Array.from(allLinks));
}

// Listen for messages FROM background or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isContextValid()) return;

    if (request.action === 'start') {
        chrome.storage.local.set({ isRunning: true }, () => {
            checkAndRun();
        });
    }

    if (request.action === 'stop') {
        chrome.storage.local.set({ isRunning: false });
        sendLog("Extraction stopped.", "warn");
    }

    if (request.action === 'pageFinished') {
        chrome.storage.local.get(['isRunning', 'pages'], (data) => {
            if (!data.isRunning) return;

            const nextPagesCount = (data.pages || 0) + 1;
            chrome.storage.local.set({ pages: nextPagesCount });

            const nextBtn = findNextButton();
            if (nextBtn) {
                console.log("IGR Scraper: Batch finished. Moving to next page...");
                sendLog(`Moving to Page ${nextPagesCount + 1}...`, "info");
                nextBtn.setAttribute('data-scraper-id', 'next-page-btn');
                chrome.runtime.sendMessage({
                    action: 'triggerNextPage',
                    nextPage: nextPagesCount
                });
            } else {
                console.log("IGR Scraper: All pages finished.");
                sendLog("No more pages found. Sequence finished.", "success");
                chrome.storage.local.set({ isRunning: false });
                chrome.runtime.sendMessage({ action: 'finished' });
            }
        });
    }

    if (request.action === 'rescan') {
        chrome.storage.local.get(['isRunning', 'urls', 'pages'], (data) => {
            if (!data.isRunning) return;
            console.log(`IGR Scraper: Rescanning after pagination (Page ${data.pages || 0})...`);
            scrapeWithRetry(data.urls || [], data.pages || 0);
        });
    }
});

async function scrapePage(existingUrls, pagesCount, allLinks) {
    if (!isContextValid()) return;

    const queueForBackground = [];
    const newLinks = [];

    allLinks.forEach((link, index) => {
        let realIndex = index;
        const onclickText = link.getAttribute('onclick') || '';
        const match = onclickText.match(/indexII\$(\d+)/);
        if (match) realIndex = parseInt(match[1]);

        const scraperId = `btn_p${pagesCount}_i${realIndex}`;
        link.setAttribute('data-scraper-id', scraperId);

        link.style.border = extractionConfig.highlightColor;
        link.style.boxShadow = "0 0 10px rgba(99, 102, 241, 0.5)";

        let docName = "IGR_Doc";
        try {
            const row = link.closest('tr');
            if (row && row.cells.length >= 3) {
                const docNo = row.cells[0].innerText.trim();
                const dName = row.cells[1].innerText.trim();
                const rDate = row.cells[2].innerText.trim();
                docName = `${docNo}_${dName}_${rDate}`.replace(/[\\/:*?"<>|]/g, '_');
            }
        } catch (e) { }

        let item = {
            id: scraperId,
            index: realIndex,
            filename: `${docName}_P${pagesCount + 1}_R${realIndex + 1}`,
            scrapedAt: new Date().toISOString()
        };

        newLinks.push(item);
        queueForBackground.push({ id: scraperId, index: realIndex, filename: item.filename });
    });

    const updatedUrls = [...existingUrls, ...newLinks];
    chrome.storage.local.get(['isRunning'], (data) => {
        if (!data.isRunning) return;

        chrome.storage.local.set({ urls: updatedUrls });
        chrome.runtime.sendMessage({
            action: 'updateStats',
            urls: updatedUrls.length,
            pages: pagesCount + 1
        });

        if (queueForBackground.length > 0) {
            console.log(`IGR Scraper: Enqueueing ${queueForBackground.length} documents...`);
            chrome.runtime.sendMessage({
                action: 'enqueueDownloads',
                links: queueForBackground
            });
        }
    });
}

function findNextButton() {
    const allPageLinks = Array.from(document.querySelectorAll("a[href*='Page$'], a[onclick*='Page$']"));
    const grid = document.getElementById('RegistrationGrid');
    let currentPage = 1;

    if (grid) {
        const pagerRow = grid.querySelector('tr:last-child');
        if (pagerRow) {
            const currentSpan = pagerRow.querySelector('span, b');
            if (currentSpan) {
                const parsed = parseInt(currentSpan.innerText.trim());
                if (!isNaN(parsed)) currentPage = parsed;
            }
        }
    }

    const nextPageNum = currentPage + 1;
    const nextLink = allPageLinks.find(a => (parseInt(a.innerText.trim()) === nextPageNum) || ((a.innerText.trim() === '...') && (a.getAttribute('onclick') || '').includes(`Page$${nextPageNum}`)));

    if (nextLink) return nextLink;

    // Last resort
    return document.querySelector("[id*='btnNext'], .next, .PagerNext");
}

if (document.readyState === 'complete') {
    setTimeout(checkAndRun, 2500);
} else {
    window.addEventListener('load', () => setTimeout(checkAndRun, 2500));
}
