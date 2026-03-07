/**
 * FlowLens AI — Content Script
 * Bridge between FlowLensTracker and chrome.storage.local.
 *
 * Trigger priority:
 *   1. chrome.storage.onChanged  (PRIMARY — most reliable)
 *   2. chrome.runtime.onMessage  (SECONDARY — backup from popup)
 *   3. On-load storage check     (handles page navigations mid-recording)
 *
 * Syncs tracker.getData() → flowlens_session_data every second.
 */

(function() {
  var syncInterval = null;
  var clickSyncTimeout = null;
  var isStarted = false;
  var startRetryCount = 0;
  var MAX_START_RETRIES = 20; // 20 * 100ms = 2 seconds max wait

  function log(msg) {
    console.log('[FlowLens Content] ' + msg);
  }

  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /**
   * Attempts to start the tracker. If FlowLensTracker is not yet defined
   * (timing issue), retries every 100ms up to MAX_START_RETRIES times.
   */
  function startTracking(retriesLeft) {
    if (isStarted) {
      log('Already started, skipping');
      return;
    }

    if (typeof retriesLeft === 'undefined') {
      retriesLeft = MAX_START_RETRIES;
    }

    if (typeof window.FlowLensTracker === 'undefined') {
      if (retriesLeft > 0) {
        log('FlowLensTracker not yet available, retrying... (' + retriesLeft + ' left)');
        setTimeout(function() { startTracking(retriesLeft - 1); }, 100);
      } else {
        log('ERROR: FlowLensTracker never became available after retries');
      }
      return;
    }

    try {
      window.FlowLensTracker.start();
      isStarted = true;

      // Import accumulated data from previous pages in this recording session
      try {
        chrome.storage.local.get(['flowlens_session_data'], function(result) {
          if (chrome.runtime.lastError) return;
          var raw = result.flowlens_session_data;
          if (raw) {
            var prevData;
            try {
              prevData = typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch(e) { prevData = null; }
            if (prevData && prevData.session && typeof window.FlowLensTracker !== 'undefined') {
              window.FlowLensTracker.importPreviousData(prevData);
              log('Imported previous session data: ' + (prevData.pages ? prevData.pages.length : 0) + ' pages, ' + (prevData.metrics ? prevData.metrics.totalClicks : 0) + ' clicks');
            }
          }
        });
      } catch(e) {
        log('Error importing previous data: ' + e.message);
      }

      startSync();
      log('Tracking STARTED on ' + window.location.href);
    } catch (e) {
      log('ERROR starting tracker: ' + e.message);
    }
  }

  function stopTracking() {
    if (!isStarted) return;

    stopSync();

    try {
      window.FlowLensTracker.stop();
    } catch (e) {
      log('ERROR stopping tracker: ' + e.message);
    }

    // Final sync
    try {
      var data = window.FlowLensTracker.getData();
      if (data && isContextValid()) {
        chrome.storage.local.set({
          flowlens_session_data: JSON.stringify(data)
        });
        log('Final data synced to storage');
      }
    } catch (e) {
      log('ERROR final sync: ' + e.message);
    }

    isStarted = false;
    log('Tracking STOPPED');
  }

  /**
   * Fully resets tracker state and clears synced data.
   * Called when user clicks "Clear Data" in popup.
   */
  function resetTracking() {
    stopSync();

    try {
      if (typeof window.FlowLensTracker !== 'undefined') {
        if (window.FlowLensTracker.isActive()) {
          window.FlowLensTracker.stop();
        }
        window.FlowLensTracker.reset();
      }
    } catch (e) {
      log('ERROR resetting tracker: ' + e.message);
    }

    isStarted = false;
    log('Tracking RESET — all state cleared');
  }

  function syncDataToStorage() {
    if (!isContextValid()) {
      log('Context invalid, stopping sync');
      stopSync();
      return;
    }

    if (typeof window.FlowLensTracker === 'undefined') {
      log('Tracker undefined during sync');
      return;
    }

    if (!window.FlowLensTracker.isActive()) {
      return;
    }

    try {
      var data = window.FlowLensTracker.getData();
      if (data) {
        chrome.storage.local.set({
          flowlens_session_data: JSON.stringify(data)
        });
      }
    } catch (e) {
      log('Sync error: ' + e.message);
      if (e.message && e.message.indexOf('Extension context invalidated') !== -1) {
        stopSync();
      }
    }
  }

  function startSync() {
    stopSync();
    // Immediate first sync
    syncDataToStorage();
    syncInterval = setInterval(syncDataToStorage, 1000);
    log('Sync interval started');
  }

  function stopSync() {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
    if (clickSyncTimeout) {
      clearTimeout(clickSyncTimeout);
      clickSyncTimeout = null;
    }
  }

  // ═══════════════════════════════════════════
  // CLICK-TRIGGERED SYNC: Save data immediately after clicks
  // so it's in storage before any page navigation destroys it
  // ═══════════════════════════════════════════

  window.addEventListener('click', function() {
    if (!isStarted) return;
    // Debounced sync 150ms after click — fast enough to beat navigation
    if (clickSyncTimeout) clearTimeout(clickSyncTimeout);
    clickSyncTimeout = setTimeout(function() {
      syncDataToStorage();
    }, 150);
  }, true);

  // Save data on page unload (last chance before navigation destroys tracker)
  window.addEventListener('pagehide', function() {
    if (!isStarted) return;
    try {
      if (typeof window.FlowLensTracker !== 'undefined' && isContextValid()) {
        var data = window.FlowLensTracker.getData();
        if (data) {
          // Use synchronous-ish approach: JSON stringify and set
          chrome.storage.local.set({
            flowlens_session_data: JSON.stringify(data)
          });
        }
      }
    } catch(e) { /* page is unloading, errors expected */ }
  });

  // Also sync on visibilitychange (tab switch, minimize)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden' && isStarted) {
      syncDataToStorage();
    }
  });

  // ═══════════════════════════════════════════
  // PRIMARY TRIGGER: Watch storage for recording state changes
  // ═══════════════════════════════════════════

  try {
    chrome.storage.onChanged.addListener(function(changes, areaName) {
      if (areaName !== 'local') return;

      if (changes.flowlens_is_recording) {
        var newVal = changes.flowlens_is_recording.newValue;
        log('Storage changed: flowlens_is_recording = ' + newVal);

        if (newVal === true) {
          // Only start if this page's hostname matches the recording hostname
          chrome.storage.local.get(['flowlens_recording_hostname'], function(result) {
            if (chrome.runtime.lastError) return;
            var recordingHost = result.flowlens_recording_hostname;
            if (!recordingHost || window.location.hostname === recordingHost) {
              startTracking();
            } else {
              log('Skipping — recording is for ' + recordingHost + ', not ' + window.location.hostname);
            }
          });
        } else if (newVal === false && isStarted) {
          stopTracking();
        }
      }
    });
    log('Storage change listener registered');
  } catch (e) {
    log('ERROR registering storage listener: ' + e.message);
  }

  // ═══════════════════════════════════════════
  // SECONDARY TRIGGER: Message listener (backup)
  // ═══════════════════════════════════════════

  try {
    chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
      if (!isContextValid()) {
        try { sendResponse({ error: 'Context invalid' }); } catch(e) {}
        return true;
      }

      log('Message received: ' + msg.action);

      try {
        if (msg.action === 'START_RECORDING') {
          startTracking();
          sendResponse({ status: 'recording', started: isStarted });

        } else if (msg.action === 'STOP_RECORDING') {
          stopTracking();
          var finalData = null;
          try {
            finalData = window.FlowLensTracker.getData();
          } catch (e) { /* ok */ }
          sendResponse({ status: 'stopped', data: finalData });

        } else if (msg.action === 'GET_STATUS') {
          var trackerExists = typeof window.FlowLensTracker !== 'undefined';
          var active = isStarted && trackerExists && window.FlowLensTracker.isActive();
          var currentData = null;
          if (active) {
            try { currentData = window.FlowLensTracker.getData(); } catch(e) {}
          }
          sendResponse({
            isRecording: active,
            trackerLoaded: trackerExists,
            data: currentData
          });

        } else if (msg.action === 'GET_DATA') {
          var d = null;
          try { d = window.FlowLensTracker.getData(); } catch (e) { /* ok */ }
          sendResponse({ data: d });

        } else if (msg.action === 'RESET_TRACKER') {
          resetTracking();
          sendResponse({ status: 'reset' });

        } else {
          sendResponse({ error: 'Unknown action: ' + msg.action });
        }
      } catch (e) {
        log('Message handler error: ' + e.message);
        try { sendResponse({ error: e.message }); } catch(e2) {}
      }
      return true;
    });
    log('Message listener registered');
  } catch (e) {
    log('ERROR registering message listener: ' + e.message);
  }

  // ═══════════════════════════════════════════
  // ON LOAD: Check if recording is already active
  // (handles page navigations during active recording)
  // ═══════════════════════════════════════════

  if (isContextValid()) {
    chrome.storage.local.get(['flowlens_is_recording', 'flowlens_recording_hostname'], function(result) {
      if (chrome.runtime.lastError) {
        log('Error reading storage: ' + chrome.runtime.lastError.message);
        return;
      }
      if (result.flowlens_is_recording === true) {
        var recordingHost = result.flowlens_recording_hostname;
        if (!recordingHost || window.location.hostname === recordingHost) {
          log('Recording was active on page load, starting tracker...');
          startTracking();
        } else {
          log('Recording active but for ' + recordingHost + ', not ' + window.location.hostname);
        }
      }
    });
  }

  log('Content script loaded on ' + window.location.href);
})();
