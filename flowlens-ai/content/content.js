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
  }

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
          startTracking();
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
    chrome.storage.local.get(['flowlens_is_recording'], function(result) {
      if (chrome.runtime.lastError) {
        log('Error reading storage: ' + chrome.runtime.lastError.message);
        return;
      }
      if (result.flowlens_is_recording === true) {
        log('Recording was active on page load, starting tracker...');
        startTracking();
      }
    });
  }

  log('Content script loaded on ' + window.location.href);
})();
