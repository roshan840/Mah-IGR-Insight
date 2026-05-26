document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const resetBtn = document.getElementById('resetBtn');
    const taskStatus = document.getElementById('taskStatus');
    const urlCountEle = document.getElementById('urlCount');
    const pageCountEle = document.getElementById('pageCount');
    const delayInput = document.getElementById('delayInput');
    const logArea = document.getElementById('logArea');
    const scrapedCountEle = document.getElementById('scrapedCount');
    const progressBarContainer = document.getElementById('progressBarContainer');
    const progressBar = document.getElementById('progressBar');

    let isRunning = false;

    function escapeCsv(value) {
        return `"${String(value ?? '').replace(/"/g, '""')}"`;
    }

    function addLog(message, type = 'info') {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        entry.textContent = `[${time}] ${message}`;
        logArea.appendChild(entry);
        logArea.scrollTop = logArea.scrollHeight;
        while (logArea.children.length > 100) {
            logArea.removeChild(logArea.firstChild);
        }
    }

    function setRunningUI(running) {
        startBtn.innerHTML = running
            ? '<span class="loader" style="display:inline-block"></span> Stop Extraction'
            : 'Start Extraction';
        startBtn.classList.toggle('btn-primary', !running);
        startBtn.classList.toggle('btn-secondary', running);
        taskStatus.textContent = running ? 'Extracting...' : 'Idle';
        taskStatus.style.color = running ? '#22c55e' : '';
        delayInput.disabled = running;
    }

    function refreshStats(urls, scraped, pages) {
        if (urls !== undefined) urlCountEle.textContent = urls;
        if (scraped !== undefined) scrapedCountEle.textContent = scraped;
        if (pages !== undefined) pageCountEle.textContent = `Page ${pages}`;
        const hasData = (urls ?? parseInt(urlCountEle.textContent, 10)) > 0
            || (scraped ?? parseInt(scrapedCountEle.textContent, 10)) > 0;
        downloadBtn.classList.toggle('hidden', !hasData);
    }

    function updateUI(running) {
        setRunningUI(running);
        chrome.storage.local.get(['urls', 'scrapedResults'], (data) => {
            refreshStats(
                data.urls?.length ?? 0,
                data.scrapedResults?.length ?? 0,
                undefined
            );
        });
    }

    function getDelayMs() {
        return Math.max(0, parseInt(delayInput.value, 10) || 0) * 1000;
    }

    function activeTab(callback) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) callback(tabs[0].id);
        });
    }

    chrome.storage.local.get(['urls', 'scrapedResults', 'pages', 'isRunning', 'configDelay'], (data) => {
        isRunning = !!data.isRunning;
        if (data.configDelay) delayInput.value = data.configDelay / 1000;
        refreshStats(data.urls?.length ?? 0, data.scrapedResults?.length ?? 0, data.pages ?? 0);
        updateUI(isRunning);
        if (isRunning) addLog('Extraction in progress...', 'info');
    });

    delayInput.addEventListener('change', () => {
        const delay = getDelayMs();
        chrome.storage.local.set({ configDelay: delay });
        addLog(`Delay updated to ${delay / 1000}s`, 'info');
    });

    startBtn.addEventListener('click', () => {
        isRunning = !isRunning;
        chrome.storage.local.set({ isRunning });
        updateUI(isRunning);

        if (isRunning) {
            chrome.storage.local.set({ configDelay: getDelayMs(), igrLastScanKey: '' });
            addLog('Starting — will auto-detect when results load...', 'success');
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tab = tabs[0];
                if (!tab?.id) {
                    addLog('No active tab found.', 'warn');
                    isRunning = false;
                    chrome.storage.local.set({ isRunning: false });
                    updateUI(false);
                    return;
                }
                const url = tab.url || '';
                if (!/freesearchigrservice\.maharashtra\.gov\.in/i.test(url)) {
                    addLog('Open the IGR site tab, then click Start (before or after search).', 'warn');
                    isRunning = false;
                    chrome.storage.local.set({ isRunning: false });
                    updateUI(false);
                    return;
                }
                chrome.runtime.sendMessage({ action: 'startExtraction', tabId: tab.id });
            });
        } else {
            addLog('Stopping extraction...', 'warn');
            activeTab((tabId) => chrome.tabs.sendMessage(tabId, { action: 'stop' }).catch(() => { }));
            chrome.runtime.sendMessage({ action: 'stop' });
        }
    });

    resetBtn.addEventListener('click', () => {
        if (!confirm('Reset all collected data? This cannot be undone.')) return;
        chrome.storage.local.set({ urls: [], scrapedResults: [], pages: 0, isRunning: false, igrLastScanKey: '' }, () => {
            isRunning = false;
            refreshStats(0, 0, 0);
            updateUI(false);
            addLog('Data cleared.', 'warn');
            chrome.runtime.sendMessage({ action: 'stop' });
        });
    });

    downloadBtn.addEventListener('click', () => {
        chrome.storage.local.get(['scrapedResults', 'urls'], (data) => {
            const results = data.scrapedResults?.length ? data.scrapedResults : (data.urls || []);
            if (results.length === 0) {
                addLog('No data to export.', 'warn');
                return;
            }

            addLog(`Exporting ${results.length} records...`, 'info');

            const headers = [
                'Doc No', 'Registration Date', 'SRO', 'Village',
                'Document Type', 'Consideration', 'Market Value',
                'Area', 'Stamp Duty', 'Reg Fee', 'Executed Date',
                'Barcode', 'Index/Book', 'Property Description',
                'Sellers', 'Buyers', 'Scraped At'
            ];

            const rows = results.map((item) => [
                item.docNo,
                item.registrationDate || item.date,
                item.sro,
                item.village,
                item.docType,
                item.consideration,
                item.marketValue,
                item.area,
                item.stampDuty,
                item.regFee,
                item.executedDate,
                item.barcode,
                item.indexBook,
                item.propertyDesc,
                item.sellers?.join('; '),
                item.buyers?.join('; '),
                item.scrapedAt || ''
            ].map(escapeCsv).join(','));

            const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '_');
            a.href = url;
            a.download = `igr_scraped_data_${timestamp}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    });

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'updateStats') {
            if (request.urls !== undefined) {
                urlCountEle.textContent = request.urls;
                urlCountEle.style.color = '#818cf8';
                setTimeout(() => { urlCountEle.style.color = ''; }, 500);
            }
            if (request.scraped !== undefined) {
                scrapedCountEle.textContent = request.scraped;
                scrapedCountEle.style.color = '#22c55e';
                setTimeout(() => { scrapedCountEle.style.color = ''; }, 500);
            }
            if (request.pages !== undefined) {
                pageCountEle.textContent = `Page ${request.pages}`;
            }
            refreshStats(
                request.urls ?? parseInt(urlCountEle.textContent, 10),
                request.scraped ?? parseInt(scrapedCountEle.textContent, 10),
                request.pages
            );
        }

        if (request.action === 'log') {
            addLog(request.message, request.logType || 'info');
        }

        if (request.action === 'updateProgress' && progressBar && progressBarContainer) {
            progressBarContainer.style.display = 'block';
            progressBar.style.width = `${request.progress}%`;
            taskStatus.textContent = `Processing (${request.current}/${request.total})`;
        }

        if (request.action === 'finished') {
            isRunning = false;
            chrome.storage.local.set({ isRunning: false });
            updateUI(false);
            taskStatus.textContent = 'Completed!';
            taskStatus.style.color = '#22c55e';
            if (progressBar) progressBar.style.width = '100%';
            setTimeout(() => {
                if (progressBarContainer) progressBarContainer.style.display = 'none';
            }, 2000);
            addLog('Extraction completed successfully.', 'success');
        }
    });
});
