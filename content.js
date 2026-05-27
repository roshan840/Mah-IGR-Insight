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
    const PAGE_CHANGE_MAX_ATTEMPTS = 15;
    const PAGE_CHANGE_POLL_MS = 1000;

    let resultsObserver = null;
    let resultsPollTimer = null;
    let waitingForResults = false;
    let debounceTimer = null;
    let paginationInProgress = false;

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

    function stopExtraction(reason, logType = 'warn') {
        stopResultsWatch();
        paginationInProgress = false;
        chrome.storage.local.set({ isRunning: false });
        sendLog(reason, logType);
        chrome.runtime.sendMessage({ action: 'finished' });
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
        if (!isContextValid() || !waitingForResults || paginationInProgress) return;

        chrome.storage.local.get(['isRunning', 'urls', 'igrScrapedGridPages'], (data) => {
            if (!data.isRunning) {
                stopResultsWatch();
                return;
            }
            if (!isResultsFrame() || findIndexIIButtons().length === 0) return;

            const gridPage = getGridPage();
            if ((data.igrScrapedGridPages || []).includes(gridPage)) return;

            stopResultsWatch();
            scrapeWithRetry(data.urls || [], gridPage, 1);
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

    function beginScrape(existingUrls) {
        if (!isContextValid() || paginationInProgress) return;

        chrome.storage.local.get(['igrScrapedGridPages', 'isRunning'], (data) => {
            if (!data.isRunning) return;

            const gridPage = getGridPage();
            if ((data.igrScrapedGridPages || []).includes(gridPage)) {
                sendLog(`Page ${gridPage} already scraped. Not repeating.`, 'warn');
                return;
            }

            if (isResultsFrame() && findIndexIIButtons().length > 0) {
                stopResultsWatch();
                scrapeWithRetry(existingUrls, gridPage, 1);
                return;
            }

            if (window === window.top) {
                sendLog('Waiting for search results to appear...', 'info');
            }
            startResultsWatch();
        });
    }

    function checkAndRun() {
        if (!isContextValid()) return;
        chrome.storage.local.get(['isRunning', 'urls'], (data) => {
            if (data.isRunning) beginScrape(data.urls || []);
        });
    }

    async function scrapeWithRetry(existingUrls, gridPage, attempt = 1) {
        if (!isContextValid() || paginationInProgress) return;

        const domPage = getGridPage();
        if (domPage !== gridPage) {
            sendLog(`Page mismatch (on ${domPage}, expected ${gridPage}). Waiting...`, 'info');
            if (attempt < 5) {
                setTimeout(() => scrapeWithRetry(existingUrls, gridPage, attempt + 1), PAGE_CHANGE_POLL_MS);
            }
            return;
        }

        const allLinks = findIndexIIButtons();
        if (allLinks.length === 0) {
            if (attempt < 5) {
                setTimeout(() => scrapeWithRetry(existingUrls, gridPage, attempt + 1), 1500);
                return;
            }
            return;
        }

        sendLog(`Page ${gridPage}: found ${allLinks.length} documents. Starting rows...`, 'success');
        scrapePage(existingUrls, gridPage, allLinks);
    }

    function waitForGridPage(targetPage, previousPage, attempt = 1) {
        return new Promise((resolve) => {
            if (!isContextValid()) {
                resolve(false);
                return;
            }

            const current = getGridPage();
            if (current === targetPage && current > previousPage) {
                resolve(true);
                return;
            }

            if (attempt >= PAGE_CHANGE_MAX_ATTEMPTS) {
                resolve(false);
                return;
            }

            setTimeout(() => {
                waitForGridPage(targetPage, previousPage, attempt + 1).then(resolve);
            }, PAGE_CHANGE_POLL_MS);
        });
    }

    function markGridPageScraped(gridPage) {
        chrome.storage.local.get(['igrScrapedGridPages'], (data) => {
            const scraped = data.igrScrapedGridPages || [];
            if (scraped.includes(gridPage)) return;
            scraped.push(gridPage);
            scraped.sort((a, b) => a - b);
            chrome.storage.local.set({
                igrScrapedGridPages: scraped,
                pages: scraped.length
            });
        });
    }

    chrome.runtime.onMessage.addListener((request) => {
        if (!isContextValid()) return;

        if (request.action === 'start') {
            chrome.storage.local.set({
                isRunning: true,
                igrLastScanKey: '',
                igrScrapedGridPages: [],
                pages: 0
            }, () => {
                chrome.storage.local.get(['urls'], (data) => beginScrape(data.urls || []));
            });
            return;
        }

        if (request.action === 'stop') {
            stopResultsWatch();
            paginationInProgress = false;
            chrome.storage.local.set({ isRunning: false });
            sendLog('Extraction stopped.', 'warn');
            return;
        }

        if (request.action === 'pageFinished') {
            if (!isResultsFrame() || paginationInProgress) return;

            chrome.storage.local.get(['isRunning', 'igrScrapedGridPages'], (data) => {
                if (!data.isRunning) return;

                const gridPage = getGridPage();
                markGridPageScraped(gridPage);

                const targetPage = gridPage + 1;
                const nextBtn = findNextButton(targetPage);

                if (!nextBtn) {
                    sendLog(`All pages done. Last scraped page: ${gridPage}.`, 'success');
                    chrome.storage.local.set({ isRunning: false });
                    chrome.runtime.sendMessage({ action: 'finished' });
                    return;
                }

                paginationInProgress = true;
                sendLog(`Page ${gridPage} complete. Opening page ${targetPage}...`, 'info');
                nextBtn.setAttribute('data-scraper-id', 'next-page-btn');
                chrome.runtime.sendMessage({
                    action: 'triggerNextPage',
                    targetPage,
                    previousPage: gridPage
                });
            });
            return;
        }

        if (request.action === 'scrapeAfterPagination') {
            const { targetPage, previousPage } = request;
            if (!targetPage) return;

            chrome.storage.local.get(['isRunning', 'urls', 'igrScrapedGridPages'], async (data) => {
                if (!data.isRunning) {
                    paginationInProgress = false;
                    return;
                }

                const ok = await waitForGridPage(targetPage, previousPage);
                paginationInProgress = false;

                if (!ok) {
                    const stuckOn = getGridPage();
                    stopExtraction(
                        `Pagination failed (stuck on page ${stuckOn}, expected ${targetPage}). Stopped.`
                    );
                    return;
                }

                if ((data.igrScrapedGridPages || []).includes(targetPage)) {
                    stopExtraction(`Page ${targetPage} was already scraped. Stopped to avoid duplicates.`);
                    return;
                }

                sendLog(`Page ${targetPage} loaded. Scraping rows...`, 'success');
                scrapeWithRetry(data.urls || [], targetPage, 1);
            });
            return;
        }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.isRunning?.newValue || paginationInProgress) return;
        chrome.storage.local.get(['urls'], (data) => beginScrape(data.urls || []));
    });

    function scrapePage(existingUrls, gridPage, allLinks) {
        if (!isContextValid()) return;

        const queueItems = allLinks.map((link) => {
            let realIndex = 0;
            const onclickText = link.getAttribute('onclick') || link.getAttribute('href') || '';
            const match = onclickText.match(/indexII\$(\d+)/i);
            if (match) realIndex = parseInt(match[1], 10);

            const scraperId = `btn_g${gridPage}_i${realIndex}`;
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

            const filename = `${docName}_P${gridPage}_R${realIndex + 1}`;
            return { id: scraperId, index: realIndex, filename, scrapedAt: new Date().toISOString() };
        });

        const scanKey = `grid:${gridPage}:n${queueItems.length}`;

        chrome.storage.local.get(['isRunning', 'igrLastScanKey', 'igrScrapedGridPages'], (data) => {
            if (!data.isRunning || queueItems.length === 0) return;
            if ((data.igrScrapedGridPages || []).includes(gridPage)) {
                sendLog(`Page ${gridPage} already in queue. Skipping duplicate scan.`, 'warn');
                return;
            }
            if (data.igrLastScanKey === scanKey) return;

            const updatedUrls = existingUrls.concat(queueItems);
            chrome.storage.local.set({ urls: updatedUrls, igrLastScanKey: scanKey });
            chrome.runtime.sendMessage({
                action: 'updateStats',
                urls: updatedUrls.length,
                pages: (data.igrScrapedGridPages || []).length + 1
            });
            chrome.runtime.sendMessage({
                action: 'enqueueDownloads',
                links: queueItems.map(({ id, index, filename }) => ({ id, index, filename })),
                gridPage
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

    function getGridPage() {
        return getCurrentPageFromGrid(getRegistrationGrid()) || 1;
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

    function findNextButton(targetGridPage) {
        const grid = getRegistrationGrid();
        const currentPage = getGridPage();
        const targetPage = targetGridPage ?? (currentPage + 1);

        if (currentPage >= targetPage) return null;

        const links = collectPagerLinks(grid);
        const exact = links.find((l) => l.pageNum === targetPage);
        if (exact) return exact.el;

        const smallestForward = links
            .filter((l) => l.pageNum > currentPage && l.pageNum <= targetPage)
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
