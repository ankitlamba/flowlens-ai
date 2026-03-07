/**
 * FlowLens AI - Popup Script
 * Reads live stats from 'flowlens_session_data' (single structured key).
 */

// DOM Elements
var recordingToggle = document.getElementById('recordingToggle');
var generateBtn = document.getElementById('generateBtn');
var clearDataBtn = document.getElementById('clearDataBtn');
var confirmModal = document.getElementById('confirmModal');
var confirmCancel = document.getElementById('confirmCancel');
var confirmClear = document.getElementById('confirmClear');
var loadingOverlay = document.getElementById('loadingOverlay');

// Settings Elements
var settingsBtn = document.getElementById('settingsBtn');
var settingsPanel = document.getElementById('settingsPanel');
var closeSettings = document.getElementById('closeSettings');
var apiKeyInput = document.getElementById('apiKeyInput');
var saveApiKeyBtn = document.getElementById('saveApiKey');
var toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
var modeHint = document.getElementById('modeHint');
var recordingHint = document.getElementById('recordingHint');
var apiKeyStatus = document.getElementById('apiKeyStatus');

// Stats Elements
var pagesCount = document.getElementById('pagesCount');
var clicksCount = document.getElementById('clicksCount');
var rageCount = document.getElementById('rageCount');
var deadCount = document.getElementById('deadCount');
var timeElapsed = document.getElementById('timeElapsed');
var sessionIdEl = document.getElementById('sessionId');

// Past Reports Elements
var viewReportsBtn = document.getElementById('viewReportsBtn');
var reportsPanel = document.getElementById('reportsPanel');
var closeReports = document.getElementById('closeReports');
var reportsList = document.getElementById('reportsList');

// State
var isRecording = false;
var recordingStartTime = null;
var statsUpdateInterval = null;
var timerInterval = null;
var hasRecordingData = false;

/* ── Init ── */

document.addEventListener('DOMContentLoaded', function() {
    initializePopup();
    setupEventListeners();
    checkRecordingStatus();
});

function initializePopup() {
    chrome.storage.local.get([
        'flowlens_is_recording',
        'flowlens_session_id',
        'flowlens_start_time',
        'flowlens_session_data'
    ], function(storage) {
        isRecording = storage.flowlens_is_recording || false;
        recordingStartTime = storage.flowlens_start_time ? parseInt(storage.flowlens_start_time) : null;

        if (isRecording && recordingStartTime) {
            updateRecordingUI();
            startStatsUpdate();
            // Enable button immediately if recording
            hasRecordingData = true;
            generateBtn.disabled = false;
        } else {
            updateRecordingUI();
        }

        // Show session ID
        if (storage.flowlens_session_id) {
            sessionIdEl.textContent = storage.flowlens_session_id.substring(0, 8);
        }

        // If there's existing session data from a previous recording, enable generate
        if (storage.flowlens_session_data) {
            hasRecordingData = true;
            generateBtn.disabled = false;
        }

        checkApiKey();

        // Also load last stats immediately
        updateStatsDisplay();
    });
}

function checkApiKey() {
    chrome.runtime.sendMessage({ action: 'CHECK_API_KEY' }, function(response) {
        if (chrome.runtime.lastError) return;
        if (response && response.hasKey) {
            // API key exists — show AI mode
            if (modeHint) modeHint.textContent = '';
            if (apiKeyStatus) {
                apiKeyStatus.innerHTML = '<span style="color:#059669">API key configured</span>';
            }
        } else {
            // No API key — show offline mode hint
            if (modeHint) modeHint.textContent = 'Add API key in Settings for AI-powered insights';
        }
    });
}

/* ── Event Listeners ── */

function setupEventListeners() {
    recordingToggle.addEventListener('click', handleRecordingToggle);
    generateBtn.addEventListener('click', handleGenerateReport);
    clearDataBtn.addEventListener('click', function() { confirmModal.classList.remove('hidden'); });
    confirmCancel.addEventListener('click', function() { confirmModal.classList.add('hidden'); });
    confirmClear.addEventListener('click', handleClearData);

    settingsBtn.addEventListener('click', function() { settingsPanel.classList.toggle('hidden'); });
    closeSettings.addEventListener('click', function() { settingsPanel.classList.add('hidden'); });
    toggleKeyVisibility.addEventListener('click', function() {
        apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });
    saveApiKeyBtn.addEventListener('click', handleSaveApiKey);

    viewReportsBtn.addEventListener('click', handleViewReports);
    closeReports.addEventListener('click', function() { reportsPanel.classList.add('hidden'); });
}

/* ── Helper: Set recording storage keys ── */

function setRecordingStorage(sessionId) {
    chrome.storage.local.set({
        flowlens_is_recording: true,
        flowlens_session_id: sessionId,
        flowlens_start_time: recordingStartTime.toString()
    });
}

/* ── Recording Toggle ── */

function handleRecordingToggle() {
    isRecording = !isRecording;

    if (isRecording) {
        // Start recording
        recordingStartTime = Date.now();
        var newSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

        sessionIdEl.textContent = newSessionId.substring(0, 8);

        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (tabs.length === 0) return;
            var tabId = tabs[0].id;
            var tabUrl = tabs[0].url || '';

            if (tabUrl.indexOf('chrome://') === 0 || tabUrl.indexOf('edge://') === 0 || tabUrl.indexOf('about:') === 0) {
                alert('FlowLens cannot record on browser internal pages.');
                isRecording = false;
                updateRecordingUI();
                return;
            }

            // Store which hostname we're recording on
            var recordingHostname = '';
            try { recordingHostname = new URL(tabUrl).hostname; } catch(e) {}
            chrome.storage.local.set({ flowlens_recording_hostname: recordingHostname });

            // Reset any running trackers on OTHER tabs to prevent cross-tab interference
            chrome.tabs.query({}, function(allTabs) {
                for (var t = 0; t < allTabs.length; t++) {
                    if (allTabs[t].id !== tabId) {
                        try {
                            chrome.tabs.sendMessage(allTabs[t].id, { action: 'RESET_TRACKER' }, function() {
                                if (chrome.runtime.lastError) { /* ok */ }
                            });
                        } catch(e) { /* ok */ }
                    }
                }
            });

            // Clear any stale session data from previous recording
            chrome.storage.local.remove(['flowlens_session_data']);

            // Step 1: Check if content script is already loaded (via manifest)
            chrome.tabs.sendMessage(tabId, { action: 'GET_STATUS' }, function(response) {
                if (chrome.runtime.lastError || !response) {
                    // Content script NOT loaded yet — inject it, then set storage flag
                    chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        files: ['utils/tracker.js', 'content/content.js']
                    }, function() {
                        if (chrome.runtime.lastError) {
                            console.warn('[FlowLens Popup] Script injection failed:', chrome.runtime.lastError.message);
                        }
                        // Now set storage — content.js will pick up the change
                        setRecordingStorage(newSessionId);
                        // Also send message as backup
                        setTimeout(function() {
                            chrome.tabs.sendMessage(tabId, { action: 'START_RECORDING' }, function() {
                                if (chrome.runtime.lastError) { /* ok */ }
                            });
                        }, 500);
                    });
                } else {
                    // Content script is already loaded — just set the storage flag
                    setRecordingStorage(newSessionId);
                    // Also send message as backup
                    setTimeout(function() {
                        chrome.tabs.sendMessage(tabId, { action: 'START_RECORDING' }, function() {
                            if (chrome.runtime.lastError) { /* ok */ }
                        });
                    }, 200);
                }
            });
        });

        startStatsUpdate();
        // Enable generate button immediately — user is recording
        hasRecordingData = true;
        generateBtn.disabled = false;
    } else {
        // Stop recording
        stopRecording();
    }

    updateRecordingUI();
}

function stopRecording() {
    chrome.storage.local.set({ flowlens_is_recording: false });

    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length > 0) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'STOP_RECORDING' }, function(response) {
                if (chrome.runtime.lastError) return;
                if (response && response.data) {
                    updateStatsFromData(response.data);
                    // Explicitly write final data to storage
                    chrome.storage.local.set({
                        flowlens_session_data: JSON.stringify(response.data)
                    });
                }
            });
        }
    });

    stopStatsUpdate();
    // Keep button enabled after stop
    generateBtn.disabled = false;
    hasRecordingData = true;
    setTimeout(updateStatsDisplay, 500);
}

/* ── Stats ── */

var pendingStatsUpdate = null;
var lastStatsValues = {};

function updateTimerDisplay() {
    if (isRecording && recordingStartTime) {
        var elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        var minutes = Math.floor(elapsed / 60);
        var seconds = elapsed % 60;
        var newTime = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        if (timeElapsed.textContent !== newTime) {
            timeElapsed.textContent = newTime;
        }
    }
}

function startStatsUpdate() {
    if (timerInterval) clearInterval(timerInterval);
    if (statsUpdateInterval) clearInterval(statsUpdateInterval);

    updateTimerDisplay();
    timerInterval = setInterval(updateTimerDisplay, 500);

    updateStatsDisplay();
    statsUpdateInterval = setInterval(updateStatsDisplay, 2000);
}

function stopStatsUpdate() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (statsUpdateInterval) { clearInterval(statsUpdateInterval); statsUpdateInterval = null; }
}

function updateStatsFromData(data) {
    if (!data) return;
    var metrics = data.metrics || {};
    var pages = data.pages || [];

    applyStatsToDOM(metrics, pages);
}

/**
 * Apply stats to DOM only if values have actually changed (prevents flicker)
 */
function applyStatsToDOM(metrics, pages) {
    var newPages = (metrics.uniquePages || metrics.totalPages || pages.length).toString();
    var newClicks = (metrics.totalClicks || 0).toString();
    var newRage = (metrics.rageClickCount || 0).toString();
    var newDead = (metrics.deadClickCount || 0).toString();

    // Only update DOM if values changed
    if (lastStatsValues.pages !== newPages) {
        pagesCount.textContent = newPages;
        lastStatsValues.pages = newPages;
    }
    if (lastStatsValues.clicks !== newClicks) {
        clicksCount.textContent = newClicks;
        lastStatsValues.clicks = newClicks;
    }
    if (lastStatsValues.rage !== newRage) {
        rageCount.textContent = newRage;
        lastStatsValues.rage = newRage;
    }
    if (lastStatsValues.dead !== newDead) {
        deadCount.textContent = newDead;
        lastStatsValues.dead = newDead;
    }

    hasRecordingData = (metrics.totalClicks || 0) > 0 || pages.length > 0;
    if (hasRecordingData) generateBtn.disabled = false;
}

function updateStatsDisplay() {
    // Debounce storage reads
    if (pendingStatsUpdate) return;
    pendingStatsUpdate = true;

    chrome.storage.local.get(['flowlens_session_data'], function(storage) {
        pendingStatsUpdate = false;
        if (chrome.runtime.lastError) return;
        var raw = storage.flowlens_session_data;

        if (raw) {
            var data;
            if (typeof raw === 'string') {
                try { data = JSON.parse(raw); } catch (e) { data = null; }
            } else {
                data = raw;
            }

            if (data) {
                var metrics = data.metrics || {};
                var pages = data.pages || [];
                applyStatsToDOM(metrics, pages);
            }
        }
    });
}

/* ── UI State ── */

function updateRecordingUI() {
    if (isRecording) {
        recordingToggle.classList.remove('stopped');
        recordingToggle.classList.add('recording');
        recordingToggle.dataset.state = 'recording';
        recordingToggle.innerHTML = '<span class="rec-dot"></span><span class="btn-text">Stop Analysis</span>';
    } else {
        recordingToggle.classList.remove('recording');
        recordingToggle.classList.add('stopped');
        recordingToggle.dataset.state = 'stopped';
        recordingToggle.innerHTML = '<span class="btn-text">Start Analysis</span>';
    }
}

/* ── Generate Report (auto-stops recording, waits for sync, then generates) ── */

function handleGenerateReport() {
    if (!hasRecordingData) {
        alert('No data recorded yet. Start analysis first.');
        return;
    }

    showLoading();

    // Reset all counters to zero immediately — session is done
    pagesCount.textContent = '0';
    clicksCount.textContent = '0';
    rageCount.textContent = '0';
    deadCount.textContent = '0';
    timeElapsed.textContent = '00:00';
    sessionIdEl.textContent = '\u2014';
    lastStatsValues = {};
    hasRecordingData = false;
    generateBtn.disabled = true;
    recordingStartTime = null;

    // Auto-stop recording first if active, then generate
    // IMPORTANT: Get data BEFORE setting flowlens_is_recording = false.
    // The storage.onChanged listener in content.js fires on that flag and
    // stops the tracker — if it fires before STOP_RECORDING arrives, the
    // tracker may lose the final data snapshot.
    if (isRecording) {
        isRecording = false;
        stopStatsUpdate();
        updateRecordingUI();

        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (tabs.length > 0) {
                var tabId = tabs[0].id;

                // Step 1: Send STOP_RECORDING to get final data while tracker is still alive
                chrome.tabs.sendMessage(tabId, { action: 'STOP_RECORDING' }, function(response) {
                    // Step 2: NOW set the storage flag — safe because we already have the data
                    chrome.storage.local.set({ flowlens_is_recording: false });

                    if (!chrome.runtime.lastError && response && response.data) {
                        // Got data from content script — write to storage, then generate
                        chrome.storage.local.set({
                            flowlens_session_data: JSON.stringify(response.data)
                        }, function() {
                            triggerGenerate();
                        });
                    } else {
                        // Message failed — try executeScript as last resort
                        fetchDataViaExecuteScript(tabId, function() {
                            triggerGenerate();
                        });
                    }
                });
            } else {
                // No active tab — set flag and try generating from whatever is in storage
                chrome.storage.local.set({ flowlens_is_recording: false });
                setTimeout(triggerGenerate, 500);
            }
        });
    } else {
        // Not recording, generate immediately from storage
        triggerGenerate();
    }
}

/**
 * Last-resort: inject a script to grab FlowLensTracker.getData() directly.
 * Tries ISOLATED world first (where content scripts live), then MAIN world.
 */
function fetchDataViaExecuteScript(tabId, callback) {
    var fetchFunc = function() {
        if (typeof FlowLensTracker !== 'undefined') {
            try {
                FlowLensTracker.stop();
                return FlowLensTracker.getData();
            } catch (e) {
                return null;
            }
        }
        return null;
    };

    chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: fetchFunc
    }, function(results) {
        if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) {
            // Try MAIN world as fallback
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: fetchFunc,
                world: 'MAIN'
            }, function(results2) {
                if (chrome.runtime.lastError || !results2 || !results2[0] || !results2[0].result) {
                    setTimeout(callback, 300);
                    return;
                }
                var data = results2[0].result;
                chrome.storage.local.set({
                    flowlens_session_data: JSON.stringify(data)
                }, callback);
            });
            return;
        }
        var data = results[0].result;
        chrome.storage.local.set({
            flowlens_session_data: JSON.stringify(data)
        }, callback);
    });
}

function triggerGenerate() {
    chrome.runtime.sendMessage({ action: 'GENERATE_REPORT' }, function(response) {
        hideLoading();
        if (chrome.runtime.lastError) {
            alert('Error: ' + chrome.runtime.lastError.message);
            return;
        }
        if (response && response.success) {
            // report page opened by background.js
        } else {
            alert(response && response.error ? response.error : 'Error generating report. Make sure you recorded some interactions.');
        }
    });
}

/* ── Clear Data ── */

function handleClearData() {
    isRecording = false;
    stopStatsUpdate();
    recordingStartTime = null;

    // Step 1: Send RESET to ALL tabs (not just active tab) to clear in-memory tracker state
    chrome.tabs.query({}, function(tabs) {
        for (var i = 0; i < tabs.length; i++) {
            try {
                chrome.tabs.sendMessage(tabs[i].id, { action: 'RESET_TRACKER' }, function() {
                    if (chrome.runtime.lastError) { /* ok - tab may not have content script */ }
                });
            } catch(e) { /* ok */ }
        }
    });

    // Step 2: Clear ALL flowlens storage keys including reports
    chrome.storage.local.remove([
        'flowlens_is_recording', 'flowlens_session_id', 'flowlens_start_time',
        'flowlens_session_data', 'flowlens_last_session_data', 'flowlens_last_sync',
        'flowlens_reports', 'flowlens_recording_state', 'flowlens_recording_hostname'
    ]);

    // Step 3: Reset UI
    pagesCount.textContent = '0';
    clicksCount.textContent = '0';
    rageCount.textContent = '0';
    deadCount.textContent = '0';
    timeElapsed.textContent = '00:00';
    sessionIdEl.textContent = '\u2014';
    generateBtn.disabled = true;
    hasRecordingData = false;
    lastStatsValues = {};
    updateRecordingUI();
    confirmModal.classList.add('hidden');
}

/* ── Past Reports ── */

function handleViewReports() {
    reportsPanel.classList.toggle('hidden');
    if (!reportsPanel.classList.contains('hidden')) {
        loadReportsList();
    }
}

function loadReportsList() {
    chrome.storage.local.get('flowlens_reports', function(result) {
        var reports = result.flowlens_reports || [];

        if (reports.length === 0) {
            reportsList.innerHTML = '<p class="no-reports">No reports yet. Generate your first report!</p>';
            return;
        }

        // Sort newest first
        reports.sort(function(a, b) {
            return new Date(b.timestamp) - new Date(a.timestamp);
        });

        var html = '';
        for (var i = 0; i < reports.length; i++) {
            var r = reports[i];
            var date = new Date(r.timestamp);
            var dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            var site = r.hostname || 'Unknown site';
            var mode = r.mode === 'ai' ? 'AI' : 'Offline';

            html += '<div class="report-item" data-report-id="' + r.id + '">';
            html += '<div class="report-item-info">';
            html += '<div class="report-item-site">' + site + '</div>';
            html += '<div class="report-item-date">' + dateStr + ' &middot; ' + mode + '</div>';
            html += '</div>';
            html += '<span class="report-item-arrow">&rarr;</span>';
            html += '</div>';
        }

        reportsList.innerHTML = html;

        // Add click handlers
        var items = reportsList.querySelectorAll('.report-item');
        for (var j = 0; j < items.length; j++) {
            items[j].addEventListener('click', function() {
                var reportId = this.getAttribute('data-report-id');
                var reportUrl = chrome.runtime.getURL('report/report.html') + '?id=' + reportId;
                chrome.tabs.create({ url: reportUrl });
            });
        }
    });
}

/* ── API Key ── */

function handleSaveApiKey() {
    var key = apiKeyInput.value.trim();
    if (!key) { alert('Please enter a valid API key'); return; }
    if (key.indexOf('sk-ant-') !== 0) {
        alert('Key should start with "sk-ant-"');
        return;
    }

    chrome.runtime.sendMessage({ action: 'SET_API_KEY', apiKey: key }, function(response) {
        if (chrome.runtime.lastError) { alert('Error saving key'); return; }
        if (response && response.success) {
            apiKeyInput.value = '';
            settingsPanel.classList.add('hidden');
            checkApiKey(); // Refresh the mode hint
        } else {
            alert('Error saving key');
        }
    });
}

/* ── Loading ── */

function showLoading() { loadingOverlay.classList.remove('hidden'); }
function hideLoading() { loadingOverlay.classList.add('hidden'); }

/* ── Listeners ── */

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'REPORT_READY') {
        hideLoading();
    } else if (request.action === 'DATA_UPDATED') {
        updateStatsDisplay();
    }
    sendResponse({ success: true });
});

// Note: Removed duplicate storage.onChanged listener that caused flickering.
// Stats update is now handled only by the polling interval (1.5s).

function checkRecordingStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length === 0) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'GET_STATUS' }, function(response) {
            if (chrome.runtime.lastError) return;
            if (response && response.isRecording !== undefined) {
                isRecording = response.isRecording;
                updateRecordingUI();
                if (isRecording) startStatsUpdate();
            }
        });
    });
}

window.addEventListener('unload', function() { stopStatsUpdate(); });
