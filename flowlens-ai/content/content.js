/**
 * FlowLens AI — Content Script
 * Bridge between the page tracker and the extension background service worker.
 */

(() => {
  let syncInterval = null;

  /**
   * Check if extension context is still valid (becomes invalid after extension reload)
   */
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  /**
   * Sync tracker data to chrome.storage.local so popup can read live stats
   */
  function syncDataToStorage() {
    if (!isContextValid()) {
      // Extension was reloaded — stop syncing silently
      stopSync();
      FlowLensTracker.stop();
      return;
    }

    if (!FlowLensTracker.isActive()) return;

    try {
      const data = FlowLensTracker.getData();
      chrome.storage.local.set({
        flowlens_clicks: JSON.stringify(data.clicks || []),
        flowlens_pages_visited: JSON.stringify(data.pages || []),
        flowlens_rage_clicks: JSON.stringify(data.rageClicks || []),
        flowlens_dead_clicks: JSON.stringify(data.deadClicks || []),
        flowlens_navigations: JSON.stringify(data.navigations || []),
        flowlens_url_metrics: JSON.stringify(data.urlMetrics || {}),
        flowlens_scroll_depths: JSON.stringify(data.scrollDepths || {}),
        flowlens_last_sync: Date.now()
      });
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        stopSync();
        FlowLensTracker.stop();
      }
    }
  }

  function startSync() {
    stopSync();
    syncDataToStorage();
    syncInterval = setInterval(syncDataToStorage, 1000);
  }

  function stopSync() {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  }

  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isContextValid()) return;
    try {
      if (msg.action === 'START_RECORDING') {
        FlowLensTracker.start();
        startSync();
        sendResponse({ status: 'recording' });

      } else if (msg.action === 'STOP_RECORDING') {
        FlowLensTracker.stop();
        stopSync();
        const sessionData = FlowLensTracker.getData();

        // Final sync to storage
        chrome.storage.local.set({
          flowlens_clicks: JSON.stringify(sessionData.clicks || []),
          flowlens_pages_visited: JSON.stringify(sessionData.pages || []),
          flowlens_rage_clicks: JSON.stringify(sessionData.rageClicks || []),
          flowlens_dead_clicks: JSON.stringify(sessionData.deadClicks || []),
          flowlens_navigations: JSON.stringify(sessionData.navigations || []),
          flowlens_url_metrics: JSON.stringify(sessionData.urlMetrics || {}),
          flowlens_scroll_depths: JSON.stringify(sessionData.scrollDepths || {}),
          flowlens_last_session_data: JSON.stringify(sessionData)
        });

        // Also save to sessions archive
        chrome.storage.local.get(['flowlens_sessions'], (result) => {
          const sessions = result.flowlens_sessions || [];
          sessions.push(sessionData);
          chrome.storage.local.set({ flowlens_sessions: sessions });
        });

        sendResponse({ status: 'stopped', data: sessionData });

      } else if (msg.action === 'GET_STATUS') {
        sendResponse({
          isRecording: FlowLensTracker.isActive(),
          data: FlowLensTracker.isActive() ? FlowLensTracker.getData() : null
        });

      } else if (msg.action === 'GET_DATA') {
        sendResponse({ data: FlowLensTracker.getData() });

      } else {
        sendResponse({ error: 'Unknown action' });
      }
    } catch (e) {
      console.error('FlowLens message handler error:', e);
      sendResponse({ error: e.message });
    }
    return true; // keep channel open for async response
  });

  // Persist recording state across page navigations within same tab
  chrome.storage.local.get(['flowlens_is_recording'], (result) => {
    if (result.flowlens_is_recording) {
      FlowLensTracker.start();
      startSync();
    }
  });

  console.log('FlowLens AI content script loaded ✓');
})();
