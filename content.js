(function initIgrScraper() {
    if (window.__igrScraperLoaded) return;
    window.__igrScraperLoaded = true;

    const LINK_SELECTOR = [
        '#RegistrationGrid input[type="button"]',
        '#RegistrationGrid input[type="submit"]',
        '#RegistrationGrid a',
        "input[value*='ndex']",
        "input[onclick*='ndexII']",
        "input[onclick*='IndexII']",
        "a[onclick*='ndexII']",
        "a[onclick*='IndexII']",
        "[id*='btnIndex']"
    ].join(', ');
    const HIGHLIGHT_STYLE = '3px solid #6366f1';

    let resultsObserver = null;
    let resultsPollTimer = null;
    let waitingForResults = false;
    let debounceTimer = null;

    function isContextValid() {
        return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    }

    function getRegistrationGrid() {
        return document.getElementById('RegistrationGrid');
    }

    function isResultsFrame() {
        if (getRegistrationGrid()) return true;
        return findIndexIIButtons().length > 0;
    }

    function sendLog(message, logType = 'info') {
        if (!isContextValid()) return;
        chrome.runtime.sendMessage({ action: 'log', message, logType }).catch(() => { });
    }

    function isIndexIIButton(el) {
        const val = (el.value || el.textContent || el.innerText || '').toLowerCase();
        const onClick = (el.getAttribute('onclick') || el.getAttribute('href') || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        return (
            val.includes('index')
            || onClick.includes('indexii')
            || onClick.includes('indexii$')
            || id.includes('btnindex')
        );
    }

    function findIndexIIButtons() {
        const grid = getRegistrationGrid();
        const roots = grid ? [grid] : [document];
        const found = [];
        const seen = new Set();

        for (const root of roots) {
            for (const el of root.querySelectorAll(LINK_SELECTOR)) {
                if (!isIndexIIButton(el) || seen.has(el)) continue;
                seen.add(el);
                found.push(el);
            }
        }

        if (found.length > 0) return found;
        return Array.from(document.querySelectorAll(LINK_SELECTOR)).filter(isIndexIIButton);
    }

    function stopResultsWatch() {
        waitingForResults = false;
        if (resultsObserver) {
            resultsObserver.disconnect();
            resultsObserver = null;
        }
        if (resultsPollTimer) {
            clearInterval(resultsPollTimer);
            resultsPollTimer = null;
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }

    function scheduleResultsCheck() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(tryAutoScrape, 400);
    }

    function tryAutoScrape() {
        if (!isContextValid() || !waitingForResults) return;

        chrome.storage.local.get(['isRunning', 'urls', 'pages'], (data) => {
            if (!data.isRunning) {
                stopResultsWatch();
                return;
            }
            if (!isResultsFrame() || findIndexIIButtons().length === 0) return;

            stopResultsWatch();
            scrapeWithRetry(data.urls || [], data.pages || 0, 1);
        });
    }

    function startResultsWatch() {
        if (waitingForResults) return;
        waitingForResults = true;

        if (!resultsObserver) {
            resultsObserver = new MutationObserver(scheduleResultsCheck);
            const target = document.documentElement || document.body;
            if (target) {
                resultsObserver.observe(target, { childList: true, subtree: true, attributes: true });
            }
        }

        if (!resultsPollTimer) {
            resultsPollTimer = setInterval(scheduleResultsCheck, 2000);
        }

        scheduleResultsCheck();
    }

    function beginScrape(existingUrls, pagesCount) {
        if (!isContextValid()) return;

        if (isResultsFrame() && findIndexIIButtons().length > 0) {
            stopResultsWatch();
            scrapeWithRetry(existingUrls, pagesCount, 1);
            return;
        }

        if (window === window.top) {
            sendLog('Waiting for search results to appear...', 'info');
        }
        startResultsWatch();
    }

    function checkAndRun() {
        if (!isContextValid()) return;
        chrome.storage.local.get(['isRunning', 'urls', 'pages'], (data) => {
            if (data.isRunning) beginScrape(data.urls || [], data.pages || 0);
        });
    }

    async function scrapeWithRetry(existingUrls, pagesCount, attempt = 1) {
        if (!isContextValid() || !isResultsFrame()) return;

        const allLinks = findIndexIIButtons();
        if (allLinks.length === 0) {
            if (attempt < 5) {
                setTimeout(() => scrapeWithRetry(existingUrls, pagesCount, attempt + 1), 1500);
                return;
            }
            chrome.storage.local.get(['isRunning'], (data) => {
                if (data.isRunning) startResultsWatch();
            });
            return;
        }

        sendLog(`Found ${allLinks.length} documents. Starting extraction...`, 'success');
        scrapePage(existingUrls, pagesCount, allLinks);
    }

    chrome.runtime.onMessage.addListener((request) => {
        if (!isContextValid()) return;

        if (request.action === 'start') {
            chrome.storage.local.set({ isRunning: true, igrLastScanKey: '' }, () => {
                chrome.storage.local.get(['urls', 'pages'], (data) => {
                    beginScrape(data.urls || [], data.pages || 0);
                });
            });
            return;
        }

        if (request.action === 'stop') {
            stopResultsWatch();
            chrome.storage.local.set({ isRunning: false });
            sendLog('Extraction stopped.', 'warn');
            return;
        }

        if (request.action === 'pageFinished') {
            if (!isResultsFrame()) return;
            chrome.storage.local.get(['isRunning', 'pages'], (data) => {
                if (!data.isRunning) return;

                const nextPagesCount = (data.pages || 0) + 1;
                chrome.storage.local.set({ pages: nextPagesCount, igrLastScanKey: '' });

                const targetGridPage = nextPagesCount + 1;
                const nextBtn = findNextButton(targetGridPage);
                if (nextBtn) {
                    sendLog(`Moving to page ${targetGridPage} (rows ${targetGridPage * 10 - 9}–${targetGridPage * 10})...`, 'info');
                    nextBtn.setAttribute('data-scraper-id', 'next-page-btn');
                    chrome.runtime.sendMessage({ action: 'triggerNextPage', nextPage: nextPagesCount });
                } else {
                    sendLog('No more pages found. Sequence finished.', 'success');
                    chrome.storage.local.set({ isRunning: false });
                    chrome.runtime.sendMessage({ action: 'finished' });
                }
            });
            return;
        }

        if (request.action === 'rescan') {
            chrome.storage.local.get(['isRunning', 'urls', 'pages'], (data) => {
                if (!data.isRunning) return;
                beginScrape(data.urls || [], data.pages || 0);
            });
        }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.isRunning?.newValue) return;
        chrome.storage.local.get(['urls', 'pages'], (data) => {
            beginScrape(data.urls || [], data.pages || 0);
        });
    });

    function scrapePage(existingUrls, pagesCount, allLinks) {
        if (!isContextValid()) return;

        const queueItems = allLinks.map((link) => {
            let realIndex = 0;
            const onclickText = link.getAttribute('onclick') || link.getAttribute('href') || '';
            const match = onclickText.match(/indexII\$(\d+)/i);
            if (match) realIndex = parseInt(match[1], 10);

            const scraperId = `btn_p${pagesCount}_i${realIndex}`;
            link.setAttribute('data-scraper-id', scraperId);
            link.style.border = HIGHLIGHT_STYLE;
            link.style.boxShadow = '0 0 10px rgba(99, 102, 241, 0.5)';

            let docName = 'IGR_Doc';
            const row = link.closest('tr');
            if (row?.cells?.length >= 3) {
                const docNo = row.cells[0].innerText.trim();
                const dName = row.cells[1].innerText.trim();
                const rDate = row.cells[2].innerText.trim();
                docName = `${docNo}_${dName}_${rDate}`.replace(/[\\/:*?"<>|]/g, '_');
            }

            const filename = `${docName}_P${pagesCount + 1}_R${realIndex + 1}`;
            return { id: scraperId, index: realIndex, filename, scrapedAt: new Date().toISOString() };
        });

        const scanKey = `p${pagesCount}:n${queueItems.length}:f${queueItems[0]?.id || ''}`;

        chrome.storage.local.get(['isRunning', 'igrLastScanKey'], (data) => {
            if (!data.isRunning || queueItems.length === 0) return;
            if (data.igrLastScanKey === scanKey) return;

            const updatedUrls = existingUrls.concat(queueItems);
            chrome.storage.local.set({ urls: updatedUrls, igrLastScanKey: scanKey });
            chrome.runtime.sendMessage({
                action: 'updateStats',
                urls: updatedUrls.length,
                pages: pagesCount + 1
            });
            chrome.runtime.sendMessage({
                action: 'enqueueDownloads',
                links: queueItems.map(({ id, index, filename }) => ({ id, index, filename }))
            });
        });
    }

    function parsePageFromElement(el) {
        const raw = `${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''}`;
        const match = raw.match(/Page\$(\d+)/i);
        if (match) return parseInt(match[1], 10);
        const text = el.innerText.trim();
        if (/^\d+$/.test(text)) return parseInt(text, 10);
        return null;
    }

    function getCurrentPageFromGrid(grid) {
        if (!grid) return null;
        const pagerRow = grid.querySelector('tr:last-child');
        if (!pagerRow) return null;

        for (const cell of pagerRow.querySelectorAll('td')) {
            if (cell.querySelector('a')) continue;
            const label = cell.querySelector('span, b, strong') || cell;
            const n = parseInt(label.innerText.trim(), 10);
            if (!isNaN(n) && n > 0) return n;
        }
        return null;
    }

    function collectPagerLinks(grid) {
        const scope = grid || document;
        const pagerRow = grid?.querySelector('tr:last-child');
        const roots = pagerRow ? [pagerRow, scope] : [scope];
        const links = [];
        const seen = new Set();

        for (const root of roots) {
            for (const a of root.querySelectorAll('a')) {
                const pageNum = parsePageFromElement(a);
                if (pageNum == null || seen.has(a)) continue;
                seen.add(a);
                links.push({ el: a, pageNum, label: a.innerText.trim() });
            }
        }
        return links;
    }

    /**
     * Find pager control for grid page N (2 → rows 11–20, 11 → rows 101–110, etc.).
     * Handles numeric links and "..." jumps (Page$11, Page$21, …).
     */
    function findNextButton(targetGridPage) {
        const grid = getRegistrationGrid();
        const currentPage = getCurrentPageFromGrid(grid) ?? (targetGridPage - 1);
        const targetPage = targetGridPage ?? (currentPage + 1);
        const links = collectPagerLinks(grid);

        const exact = links.find((l) => l.pageNum === targetPage);
        if (exact) return exact.el;

        const smallestForward = links
            .filter((l) => l.pageNum > currentPage)
            .sort((a, b) => a.pageNum - b.pageNum)[0];
        if (smallestForward) return smallestForward.el;

        const scope = grid || document;
        for (const a of scope.querySelectorAll('a')) {
            const label = a.innerText.trim();
            if (label !== '...' && label !== '…' && !/^>+$/.test(label)) continue;
            const pageNum = parsePageFromElement(a);
            if (pageNum != null && pageNum >= targetPage) return a;
        }

        return scope.querySelector(
            "[id*='btnNext'], .next, .PagerNext, a[title*='Next' i], a[title*='अगली' i]"
        );
    }

    checkAndRun();

    if (isResultsFrame()) {
        console.log('IGR Scraper: watching for results', location.href);
    }
})();
