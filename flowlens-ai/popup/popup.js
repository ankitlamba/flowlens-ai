/**
 * FlowLens AI - Popup Script
 * Handles recording control, stats display, and report generation
 */

// DOM Elements
const recordingToggle = document.getElementById('recordingToggle');
const generateBtn = document.getElementById('generateBtn');
const viewReportsBtn = document.getElementById('viewReportsBtn');
const clearDataBtn = document.getElementById('clearDataBtn');
const confirmModal = document.getElementById('confirmModal');
const confirmCancel = document.getElementById('confirmCancel');
const confirmClear = document.getElementById('confirmClear');
const loadingOverlay = document.getElementById('loadingOverlay');

// Settings Elements
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const closeSettings = document.getElementById('closeSettings');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveApiKeyBtn = document.getElementById('saveApiKey');
const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
const apiKeyBanner = document.getElementById('apiKeyBanner');
const openSettingsFromBanner = document.getElementById('openSettingsFromBanner');

// Stats Elements
const pagesCount = document.getElementById('pagesCount');
const clicksCount = document.getElementById('clicksCount');
const rageCount = document.getElementById('rageCount');
const deadCount = document.getElementById('deadCount');
const timeElapsed = document.getElementById('timeElapsed');
const sessionId = document.getElementById('sessionId');

// State
let isRecording = false;
let recordingStartTime = null;
let statsUpdateInterval = null;
let hasRecordingData = false;

/**
 * Initialize popup on load
 */
document.addEventListener('DOMContentLoaded', async () => {
    await initializePopup();
    setupEventListeners();
    await checkRecordingStatus();
});

/**
 * Initialize popup state
 */
async function initializePopup() {
    try {
        const storage = await chrome.storage.local.get([
            'flowlens_is_recording',
            'flowlens_session_id',
            'flowlens_start_time'
        ]);

        isRecording = storage.flowlens_is_recording || false;
        recordingStartTime = storage.flowlens_start_time || null;

        if (isRecording && recordingStartTime) {
            recordingStartTime = parseInt(recordingStartTime);
            updateRecordingUI();
            startStatsUpdate();
        } else {
            updateRecordingUI();
        }

        if (storage.flowlens_session_id) {
            sessionId.textContent = storage.flowlens_session_id.substring(0, 8);
        }

        // Check if API key is set
        checkApiKey();
    } catch (error) {
        console.error('Error initializing popup:', error);
    }
}

/**
 * Check if API key is configured
 */
async function checkApiKey() {
    try {
        chrome.runtime.sendMessage({ action: 'CHECK_API_KEY' }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response && !response.hasKey) {
                apiKeyBanner.classList.remove('hidden');
            } else {
                apiKeyBanner.classList.add('hidden');
            }
        });
    } catch (e) {
        // Fallback: check storage directly
        const result = await chrome.storage.local.get('flowlens_api_key');
        if (!result.flowlens_api_key) {
            apiKeyBanner.classList.remove('hidden');
        }
    }
}

/**
 * Handle saving API key
 */
async function handleSaveApiKey() {
    const key = apiKeyInput.value.trim();
    if (!key) {
        alert('Please enter a valid API key');
        return;
    }
    if (!key.startsWith('sk-ant-')) {
        alert('That doesn\'t look like an Anthropic API key. It should start with "sk-ant-"');
        return;
    }

    chrome.runtime.sendMessage({ action: 'SET_API_KEY', apiKey: key }, (response) => {
        if (chrome.runtime.lastError) {
            alert('Error saving API key');
            return;
        }
        if (response && response.success) {
            apiKeyInput.value = '';
            apiKeyBanner.classList.add('hidden');
            settingsPanel.classList.add('hidden');
            // Show brief success feedback
            const note = document.createElement('div');
            note.className = 'key-saved-msg';
            note.textContent = '✓ API key saved!';
            settingsPanel.parentElement.insertBefore(note, settingsPanel.nextSibling);
            setTimeout(() => note.remove(), 2000);
        } else {
            alert(response?.error || 'Error saving API key');
        }
    });
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    recordingToggle.addEventListener('click', handleRecordingToggle);
    generateBtn.addEventListener('click', handleGenerateReport);
    viewReportsBtn.addEventListener('click', handleViewReports);
    clearDataBtn.addEventListener('click', showClearConfirmation);
    confirmCancel.addEventListener('click', hideClearConfirmation);
    confirmClear.addEventListener('click', handleClearData);

    // Settings listeners
    settingsBtn.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
    });
    closeSettings.addEventListener('click', () => {
        settingsPanel.classList.add('hidden');
    });
    openSettingsFromBanner.addEventListener('click', () => {
        settingsPanel.classList.remove('hidden');
        apiKeyBanner.classList.add('hidden');
    });
    toggleKeyVisibility.addEventListener('click', () => {
        apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
        toggleKeyVisibility.textContent = apiKeyInput.type === 'password' ? '👁' : '🙈';
    });
    saveApiKeyBtn.addEventListener('click', handleSaveApiKey);
}

/**
 * Check recording status from content script
 */
async function checkRecordingStatus() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) return;

        const tab = tabs[0];

        chrome.tabs.sendMessage(tab.id, { action: 'GET_STATUS' }, (response) => {
            if (chrome.runtime.lastError) {
                // Content script not loaded yet, use storage state
                return;
            }
            if (response && response.isRecording !== undefined) {
                isRecording = response.isRecording;
                updateRecordingUI();
                if (isRecording) {
                    startStatsUpdate();
                }
            }
        });
    } catch (error) {
        console.error('Error checking recording status:', error);
    }
}

/**
 * Handle recording toggle button click
 */
async function handleRecordingToggle() {
    try {
        isRecording = !isRecording;

        if (isRecording) {
            // Start recording
            recordingStartTime = Date.now();

            // Save state to storage
            const newSessionId = generateSessionId();
            await chrome.storage.local.set({
                flowlens_is_recording: true,
                flowlens_session_id: newSessionId,
                flowlens_start_time: recordingStartTime.toString(),
                flowlens_pages_visited: JSON.stringify([]),
                flowlens_clicks: JSON.stringify([]),
                flowlens_rage_clicks: JSON.stringify([]),
                flowlens_dead_clicks: JSON.stringify([])
            });

            sessionId.textContent = newSessionId.substring(0, 8);

            // Send message to content script (inject first if needed)
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length > 0) {
                const tabId = tabs[0].id;
                const tabUrl = tabs[0].url || '';

                // Skip chrome:// and edge:// pages
                if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('about:')) {
                    alert('FlowLens cannot record on browser internal pages. Please navigate to a website first.');
                    isRecording = false;
                    updateRecordingUI();
                    return;
                }

                // Try to inject content scripts first (in case they're not loaded)
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        files: ['utils/tracker.js', 'content/content.js']
                    });
                } catch (e) {
                    console.log('Scripts may already be injected or page not accessible:', e.message);
                }

                // Now send the start message
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: 'START_RECORDING' }, () => {
                        if (chrome.runtime.lastError) {
                            console.log('Content script communication issue:', chrome.runtime.lastError.message);
                        }
                    });
                }, 200);
            }

            // Start updating stats
            startStatsUpdate();
            hasRecordingData = false;
        } else {
            // Stop recording
            await chrome.storage.local.set({
                flowlens_is_recording: false
            });

            // Send message to content script and wait for data
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'STOP_RECORDING' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log('Content script not yet loaded');
                    }
                    // If we got data back from content script, enable the button directly
                    if (response && response.data) {
                        const d = response.data;
                        const hasData = (d.clicks && d.clicks.length > 0) ||
                                        (d.pages && d.pages.length > 0) ||
                                        (d.rageClicks && d.rageClicks.length > 0) ||
                                        (d.deadClicks && d.deadClicks.length > 0);
                        if (hasData) {
                            hasRecordingData = true;
                            generateBtn.disabled = false;
                            // Update stats from the response data
                            pagesCount.textContent = (d.pages || []).length.toString();
                            clicksCount.textContent = (d.clicks || []).length.toString();
                            rageCount.textContent = (d.rageClicks || []).length.toString();
                            deadCount.textContent = (d.deadClicks || []).length.toString();
                        }
                    }
                });
            }

            // Stop updating stats
            stopStatsUpdate();

            // Wait a moment for storage sync, then update stats display
            setTimeout(async () => {
                await updateStatsDisplay();
            }, 500);
        }

        updateRecordingUI();
    } catch (error) {
        console.error('Error toggling recording:', error);
        isRecording = !isRecording;
        updateRecordingUI();
    }
}

/**
 * Generate session ID
 */
function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
}

/**
 * Start stats update interval
 */
function startStatsUpdate() {
    if (statsUpdateInterval) {
        clearInterval(statsUpdateInterval);
    }

    // Update immediately
    updateStatsDisplay();

    // Update every second
    statsUpdateInterval = setInterval(() => {
        updateStatsDisplay();
    }, 1000);
}

/**
 * Stop stats update interval
 */
function stopStatsUpdate() {
    if (statsUpdateInterval) {
        clearInterval(statsUpdateInterval);
        statsUpdateInterval = null;
    }
}

/**
 * Update stats display from storage
 */
async function updateStatsDisplay() {
    try {
        const storage = await chrome.storage.local.get([
            'flowlens_pages_visited',
            'flowlens_clicks',
            'flowlens_rage_clicks',
            'flowlens_dead_clicks'
        ]);

        const pages = storage.flowlens_pages_visited ? JSON.parse(storage.flowlens_pages_visited) : [];
        const clicks = storage.flowlens_clicks ? JSON.parse(storage.flowlens_clicks) : [];
        const rageClicks = storage.flowlens_rage_clicks ? JSON.parse(storage.flowlens_rage_clicks) : [];
        const deadClicks = storage.flowlens_dead_clicks ? JSON.parse(storage.flowlens_dead_clicks) : [];

        // Update stats
        pagesCount.textContent = pages.length.toString();
        clicksCount.textContent = clicks.length.toString();
        rageCount.textContent = rageClicks.length.toString();
        deadCount.textContent = deadClicks.length.toString();

        // Update time elapsed if recording
        if (isRecording && recordingStartTime) {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            timeElapsed.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        // Check if we have recording data
        hasRecordingData = clicks.length > 0 || pages.length > 0 || rageClicks.length > 0 || deadClicks.length > 0;
        generateBtn.disabled = !hasRecordingData;

    } catch (error) {
        console.error('Error updating stats display:', error);
    }
}

/**
 * Update recording UI based on state
 */
function updateRecordingUI() {
    if (isRecording) {
        recordingToggle.classList.remove('stopped');
        recordingToggle.classList.add('recording');
        recordingToggle.dataset.state = 'recording';
        recordingToggle.innerHTML = '<span class="btn-icon">🔴</span><span class="btn-text">Stop Recording</span>';
        recordingToggle.style.pointerEvents = 'auto';
    } else {
        recordingToggle.classList.remove('recording');
        recordingToggle.classList.add('stopped');
        recordingToggle.dataset.state = 'stopped';
        recordingToggle.innerHTML = '<span class="btn-icon">⚫</span><span class="btn-text">Start Recording</span>';
        recordingToggle.style.pointerEvents = 'auto';
    }
}

/**
 * Handle generate report button click
 */
async function handleGenerateReport() {
    try {
        if (!hasRecordingData) {
            alert('No recording data available. Please record some user interactions first.');
            return;
        }

        showLoadingOverlay();

        // Send message to background script to generate report
        chrome.runtime.sendMessage(
            { action: 'GENERATE_REPORT' },
            (response) => {
                hideLoadingOverlay();

                if (chrome.runtime.lastError) {
                    console.error('Error generating report:', chrome.runtime.lastError);
                    alert('Error generating report. Please try again.');
                    return;
                }

                if (response && response.success && response.reportId) {
                    // Report page is opened by background script automatically
                    console.log('Report generated:', response.reportId);
                } else {
                    const errorMsg = response?.error || 'Error generating report. Please try again.';
                    alert(errorMsg);
                }
            }
        );
    } catch (error) {
        hideLoadingOverlay();
        console.error('Error handling generate report:', error);
        alert('Error generating report. Please try again.');
    }
}

/**
 * Handle view reports button click
 */
function handleViewReports() {
    try {
        const reportsUrl = chrome.runtime.getURL('reports/reports.html');
        chrome.tabs.create({ url: reportsUrl });
    } catch (error) {
        console.error('Error opening reports page:', error);
    }
}

/**
 * Show clear data confirmation modal
 */
function showClearConfirmation() {
    confirmModal.classList.remove('hidden');
}

/**
 * Hide clear data confirmation modal
 */
function hideClearConfirmation() {
    confirmModal.classList.add('hidden');
}

/**
 * Handle clear data confirmation
 */
async function handleClearData() {
    try {
        // Stop recording first
        if (isRecording) {
            isRecording = false;
            stopStatsUpdate();

            // Notify content script
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'STOP_RECORDING' }, () => {
                    if (chrome.runtime.lastError) {
                        console.log('Content script not yet loaded');
                    }
                });
            }
        }

        // Clear all FlowLens data from storage
        await chrome.storage.local.remove([
            'flowlens_is_recording',
            'flowlens_session_id',
            'flowlens_start_time',
            'flowlens_pages_visited',
            'flowlens_clicks',
            'flowlens_rage_clicks',
            'flowlens_dead_clicks'
        ]);

        // Reset UI
        pagesCount.textContent = '0';
        clicksCount.textContent = '0';
        rageCount.textContent = '0';
        deadCount.textContent = '0';
        timeElapsed.textContent = '00:00';
        sessionId.textContent = '—';
        generateBtn.disabled = true;
        hasRecordingData = false;

        updateRecordingUI();
        hideClearConfirmation();
    } catch (error) {
        console.error('Error clearing data:', error);
        alert('Error clearing data. Please try again.');
    }
}

/**
 * Show loading overlay
 */
function showLoadingOverlay() {
    loadingOverlay.classList.remove('hidden');
}

/**
 * Hide loading overlay
 */
function hideLoadingOverlay() {
    loadingOverlay.classList.add('hidden');
}

/**
 * Listen for messages from background script
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'REPORT_READY') {
        hideLoadingOverlay();
        if (request.reportId) {
            const reportUrl = chrome.runtime.getURL('reports/report.html?id=' + request.reportId);
            chrome.tabs.create({ url: reportUrl });
        }
    } else if (request.action === 'DATA_UPDATED') {
        // Update stats when data changes
        updateStatsDisplay();
    }
    sendResponse({ success: true });
});

/**
 * Listen for storage changes
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
        // Update stats when storage changes (both during and after recording)
        if (changes.flowlens_clicks || changes.flowlens_pages_visited ||
            changes.flowlens_rage_clicks || changes.flowlens_dead_clicks) {
            updateStatsDisplay();
        }
    }
});

/**
 * Clean up on popup close
 */
window.addEventListener('unload', () => {
    stopStatsUpdate();
});
