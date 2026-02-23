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

    let isRunning = false;

    // Load initial state
    chrome.storage.local.get(['urls', 'scrapedResults', 'pages', 'isRunning', 'configDelay'], (data) => {
        const urls = data.urls || [];
        const scraped = data.scrapedResults || [];
        const pages = data.pages || 0;
        isRunning = data.isRunning || false;

        if (data.configDelay) {
            delayInput.value = data.configDelay / 1000;
        }

        urlCountEle.textContent = urls.length;
        scrapedCountEle.textContent = scraped.length;
        pageCountEle.textContent = `Page ${pages}`;
        updateUI(isRunning);

        if (isRunning) {
            addLog('Extraction in progress...', 'info');
        }
    });

    function addLog(message, type = 'info') {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        entry.textContent = `[${time}] ${message}`;
        logArea.appendChild(entry);
        logArea.scrollTop = logArea.scrollHeight;

        // Keep only last 100 logs
        while (logArea.children.length > 100) {
            logArea.removeChild(logArea.firstChild);
        }
    }

    function updateUI(running) {
        if (running) {
            startBtn.innerHTML = '<span class="loader" style="display:inline-block"></span> Stop Extraction';
            startBtn.classList.replace('btn-primary', 'btn-secondary');
            taskStatus.textContent = 'Extracting...';
            taskStatus.style.color = '#22c55e';
            delayInput.disabled = true;
        } else {
            startBtn.innerHTML = 'Start Extraction';
            startBtn.classList.replace('btn-secondary', 'btn-primary');
            taskStatus.textContent = 'Idle';
            taskStatus.style.color = '';
            delayInput.disabled = false;
        }

        chrome.storage.local.get(['urls', 'scrapedResults'], (data) => {
            const hasData = (data.urls && data.urls.length > 0) || (data.scrapedResults && data.scrapedResults.length > 0);
            if (hasData) {
                downloadBtn.classList.remove('hidden');
            } else {
                downloadBtn.classList.add('hidden');
            }
        });
    }

    delayInput.addEventListener('change', () => {
        const delay = Math.max(2, parseInt(delayInput.value) || 3) * 1000;
        chrome.storage.local.set({ configDelay: delay });
        addLog(`Delay updated to ${delay / 1000}s`, 'info');
    });

    startBtn.addEventListener('click', () => {
        isRunning = !isRunning;
        chrome.storage.local.set({ isRunning });
        updateUI(isRunning);

        if (isRunning) {
            const delay = Math.max(2, parseInt(delayInput.value) || 3) * 1000;
            chrome.storage.local.set({ configDelay: delay });
            addLog('Starting extraction sequence...', 'success');

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { action: 'start' });
                }
            });
        } else {
            addLog('Stopping extraction...', 'warn');
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { action: 'stop' });
                }
            });
            // Also notify background
            chrome.runtime.sendMessage({ action: 'stop' });
        }
    });

    resetBtn.addEventListener('click', () => {
        if (confirm('Reset all collected data? This cannot be undone.')) {
            chrome.storage.local.set({ urls: [], scrapedResults: [], pages: 0, isRunning: false }, () => {
                urlCountEle.textContent = '0';
                scrapedCountEle.textContent = '0';
                pageCountEle.textContent = 'Page 0';
                isRunning = false;
                updateUI(false);
                addLog('Data cleared.', 'warn');
                chrome.runtime.sendMessage({ action: 'stop' });
            });
        }
    });

    downloadBtn.addEventListener('click', () => {
        chrome.storage.local.get(['scrapedResults', 'urls'], (data) => {
            const results = data.scrapedResults || data.urls || [];
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

            const csvRows = [headers.join(',')];

            results.forEach(item => {
                const row = [
                    `"${(item.docNo || '').replace(/"/g, '""')}"`,
                    `"${(item.registrationDate || item.date || '').replace(/"/g, '""')}"`,
                    `"${(item.sro || '').replace(/"/g, '""')}"`,
                    `"${(item.village || '').replace(/"/g, '""')}"`,
                    `"${(item.docType || '').replace(/"/g, '""')}"`,
                    `"${(item.consideration || '').replace(/"/g, '""')}"`,
                    `"${(item.marketValue || '').replace(/"/g, '""')}"`,
                    `"${(item.area || '').replace(/"/g, '""')}"`,
                    `"${(item.stampDuty || '').replace(/"/g, '""')}"`,
                    `"${(item.regFee || '').replace(/"/g, '""')}"`,
                    `"${(item.executedDate || '').replace(/"/g, '""')}"`,
                    `"${(item.barcode || '').replace(/"/g, '""')}"`,
                    `"${(item.indexBook || '').replace(/"/g, '""')}"`,
                    `"${(item.propertyDesc || '').replace(/"/g, '""')}"`,
                    `"${(item.sellers ? item.sellers.join('; ') : '').replace(/"/g, '""')}"`,
                    `"${(item.buyers ? item.buyers.join('; ') : '').replace(/"/g, '""')}"`,
                    `"${item.scrapedAt || ''}"`
                ];
                csvRows.push(row.join(','));
            });

            const csvString = csvRows.join('\n');
            const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '_');
            a.href = url;
            a.download = `igr_scraped_data_${timestamp}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    });

    // Listen for events from background/content
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
        }

        if (request.action === 'log') {
            addLog(request.message, request.logType || 'info');
        }

        if (request.action === 'updateProgress') {
            const container = document.getElementById('progressBarContainer');
            const bar = document.getElementById('progressBar');
            if (container && bar) {
                container.style.display = 'block';
                bar.style.width = `${request.progress}%`;
            }
            taskStatus.textContent = `Processing (${request.current}/${request.total})`;
        }

        if (request.action === 'finished') {
            isRunning = false;
            chrome.storage.local.set({ isRunning: false });
            updateUI(false);
            taskStatus.textContent = 'Completed!';
            taskStatus.style.color = '#22c55e';

            const bar = document.getElementById('progressBar');
            const container = document.getElementById('progressBarContainer');
            if (bar) bar.style.width = '100%';
            setTimeout(() => {
                if (container) container.style.display = 'none';
            }, 2000);

            addLog('Extraction completed successfully.', 'success');
        }
    });
});
