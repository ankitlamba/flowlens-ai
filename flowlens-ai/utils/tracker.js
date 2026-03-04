/**
 * FlowLensTracker - Deterministic UX Diagnostic Engine
 *
 * A content script tracking engine for Chrome extensions that captures behavioral
 * metadata and friction signals without recording sensitive user data.
 *
 * Public API: start(), stop(), getData(), isActive()
 */

(function() {
  'use strict';

  // ============================================================================
  // CONFIGURATION & CONSTANTS
  // ============================================================================

  var CONFIG = {
    IDLE_THRESHOLD_MS: 15000,
    HOVER_HESITATION_THRESHOLD_MS: 2000,
    DEAD_CLICK_DETECTION_TIMEOUT_MS: 500,
    RAGE_CLICK_WINDOW_MS: 1000,
    RAGE_CLICK_THRESHOLD: 3,
    TTFA_THRESHOLD_MS: 5000,
    URL_POLL_INTERVAL_MS: 500,
    MAX_TEXT_LENGTH: 80,
    TRACKING_PARAMS: [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', '_ga', 'ref', 'source', 'mc_cid', 'mc_eid'
    ]
  };

  var FRICTION_SEVERITY = {
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW_MEDIUM: 'low-medium',
    LOW: 'low'
  };

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  var state = {
    isActive: false,
    sessionId: null,
    sessionStartTime: null,
    sessionEndTime: null,
    hostname: null,
    currentPageId: null,
    rawEvents: [],
    pages: {},
    frictionSignals: [],
    navigationHistory: [],
    lastUrl: null,
    lastNormalizedUrl: null,
    lastChangeType: null,
    idleTimer: null,
    hoverTracking: {},
    clickHistory: [],
    totalStrippedParams: 0,
    mutationObservers: [],
    pendingDeadClickDetection: null
  };

  // ============================================================================
  // UTILITY: URL NORMALIZATION
  // ============================================================================

  /**
   * Normalizes a URL by stripping tracking parameters while preserving state params.
   * @param {string} url - The URL to normalize
   * @returns {object} - { pathname, query, normalized, raw, strippedParams }
   */
  function normalizeUrl(url) {
    try {
      var urlObj = new URL(url);
      var pathname = urlObj.pathname;
      var params = new URLSearchParams(urlObj.search);

      var stateParams = new URLSearchParams();
      var strippedCount = 0;

      // Iterate through all params and separate state from tracking params
      for (var pair of params) {
        var key = pair[0];
        var value = pair[1];
        if (CONFIG.TRACKING_PARAMS.indexOf(key.toLowerCase()) !== -1) {
          strippedCount++;
        } else {
          stateParams.append(key, value);
        }
      }

      var query = stateParams.toString();
      var normalized = query ? pathname + '?' + query : pathname;

      state.totalStrippedParams += strippedCount;

      return {
        pathname: pathname,
        query: query,
        normalized: normalized,
        raw: url,
        strippedParams: strippedCount
      };
    } catch (error) {
      console.warn('[FlowLensTracker] URL normalization failed:', error);
      return {
        pathname: '/',
        query: '',
        normalized: '/',
        raw: url,
        strippedParams: 0
      };
    }
  }

  // ============================================================================
  // UTILITY: ELEMENT UTILITIES
  // ============================================================================

  /**
   * Gets visible text from an element, truncated to MAX_TEXT_LENGTH
   */
  function getElementText(el) {
    var text = (el.textContent || el.innerText || el.value || '').trim();
    return text.substring(0, CONFIG.MAX_TEXT_LENGTH);
  }

  /**
   * Gets aria-label or falls back to text content
   */
  function getAccessibilityLabel(el) {
    return el.getAttribute('aria-label') || getElementText(el);
  }

  /**
   * Gets a stable, short CSS selector for an element (max 3 levels, prefers IDs)
   */
  function getStableSelector(el) {
    if (!el) return null;

    if (el.id) return '#' + el.id;

    var selector = '';
    var current = el;
    var depth = 0;

    while (current && current !== document.body && depth < 3) {
      var part = current.tagName.toLowerCase();

      if (current.id) {
        part = part + '#' + current.id;
      } else if (current.getAttribute && current.getAttribute('class')) {
        var classStr = current.getAttribute('class');
        var classes = classStr.split(/\s+/)
          .filter(function(c) { return c && !c.startsWith('_'); })
          .slice(0, 2)
          .join('.');
        if (classes) part = part + '.' + classes;
      }

      selector = part + (selector ? ' > ' + selector : '');
      current = current.parentElement;
      depth++;
    }

    return selector || 'body';
  }

  /**
   * Gets human-readable element description for evidence
   */
  function getElementDescription(el) {
    if (!el) return 'unknown element';

    var tag = (el.tagName || 'div').toLowerCase();
    var text = getElementText(el);
    var ariaLabel = el.getAttribute('aria-label');
    var label = text || ariaLabel || '';

    if (label.length > 50) label = label.substring(0, 47) + '...';

    if (tag === 'a') return label ? 'Link: "' + label + '"' : 'Link';
    if (tag === 'button' || el.getAttribute('role') === 'button') {
      return label ? 'Button: "' + label + '"' : 'Button';
    }
    if (el.getAttribute('role') === 'link') return label ? 'Link: "' + label + '"' : 'Link';
    if (tag === 'input') return 'Input (' + (el.type || 'text') + ')';
    if (tag === 'select') return 'Dropdown';
    if (tag === 'img') return el.alt ? 'Image: "' + el.alt + '"' : 'Image';
    if (label) return '"' + label + '"';
    return tag + ' element';
  }

  /**
   * Checks if an element is interactive (clickable)
   */
  function isInteractiveElement(el) {
    if (!el) return false;
    var interactive = [
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'
    ];
    if (interactive.indexOf(el.tagName) !== -1) return true;
    if (el.getAttribute('role') === 'button' ||
        el.getAttribute('role') === 'link' ||
        el.getAttribute('role') === 'tab') {
      return true;
    }
    return false;
  }

  /**
   * Gets element type for event tracking
   */
  function getElementType(el) {
    var tag = (el.tagName || 'div').toLowerCase();
    if (tag === 'input') return 'input-' + el.type;
    if (tag === 'a') return 'link';
    if (el.hasAttribute('role')) return '[role="' + el.getAttribute('role') + '"]';
    return tag;
  }

  // ============================================================================
  // UTILITY: SCROLL DEPTH CALCULATION
  // ============================================================================

  /**
   * Calculates current scroll depth as a percentage.
   * Checks both window scroll and common SPA scroll containers.
   */
  function getScrollDepthPercent() {
    var windowHeight = window.innerHeight;

    // First check window-level scroll
    var docHeight = document.documentElement.scrollHeight;
    var scrollTop = window.scrollY || document.documentElement.scrollTop;

    // Also check common SPA scroll containers (LinkedIn uses main.scaffold-layout__main)
    var containerScroll = getContainerScrollDepth();

    // Use the larger of window scroll or container scroll
    var depth;
    if (docHeight <= windowHeight) {
      // Page fits in window
      if (containerScroll > 0) {
        // But a scrollable container exists, use container scroll
        depth = containerScroll;
      } else {
        // No scrollable container, page fits
        depth = 100;
      }
    } else if (containerScroll > 0) {
      // Use container scroll depth if found
      depth = containerScroll;
    } else {
      depth = Math.min(100, Math.round(((scrollTop + windowHeight) / docHeight) * 100));
    }

    return Math.min(100, Math.round(depth));
  }

  /**
   * Check for scroll depth inside common SPA scrollable containers
   */
  function getContainerScrollDepth() {
    // Common SPA scroll container selectors
    var selectors = [
      'main', '[role="main"]', '.scaffold-layout__main',
      '#main-content', '.main-content', '[data-scroll-container]'
    ];

    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.scrollHeight > el.clientHeight + 50) {
        var depth = ((el.scrollTop + el.clientHeight) / el.scrollHeight) * 100;
        return depth;
      }
    }
    return -1; // No scrollable container found
  }

  // ============================================================================
  // EVENT RECORDING
  // ============================================================================

  /**
   * Records a raw event with all required metadata
   */
  function recordRawEvent(eventType, eventData) {
    if (!state.isActive || !state.sessionId) return;

    if (!eventData) eventData = {};

    var event = {
      sessionId: state.sessionId,
      timestamp: Date.now(),
      eventType: eventType,
      normalizedUrl: state.lastNormalizedUrl,
      rawUrl: window.location.href,
      pageTitle: document.title,
      pathname: window.location.pathname,
      queryParams: new URLSearchParams(window.location.search).toString(),
      pageId: state.currentPageId
    };

    // Merge eventData properties
    for (var key in eventData) {
      if (eventData.hasOwnProperty(key)) {
        event[key] = eventData[key];
      }
    }

    state.rawEvents.push(event);
  }

  // ============================================================================
  // PAGE TRACKING
  // ============================================================================

  /**
   * Creates a new page object
   */
  function createPageObject(pageId, pathname, queryState) {
    return {
      pageId: pageId,
      pathname: pathname,
      queryState: queryState || '',
      entryTimestamp: Date.now(),
      exitTimestamp: null,
      timeSpent: null,
      maxScrollDepth: 0,
      hasScrolled: false,
      timeToScroll50: null,
      timeToScroll75: null,
      ttfa: null,
      clickCount: 0,
      clickActions: [],
      frictionSignals: [],
      events: []
    };
  }

  /**
   * Transitions to a new page
   */
  function transitionToPage(changeType) {
    if (!changeType) changeType = 'PAGE_CHANGE';

    var normalized = normalizeUrl(window.location.href);
    var currentTime = Date.now();

    // Close current page if exists
    if (state.currentPageId && state.pages[state.currentPageId]) {
      var currentPage = state.pages[state.currentPageId];
      currentPage.exitTimestamp = currentTime;
      currentPage.timeSpent = currentTime - currentPage.entryTimestamp;
    }

    // Record navigation event
    if (state.lastNormalizedUrl) {
      recordRawEvent('page_change', {
        fromUrl: state.lastNormalizedUrl,
        toUrl: normalized.normalized,
        changeType: changeType,
        strippedParams: normalized.strippedParams
      });

      state.navigationHistory.push({
        from: state.lastNormalizedUrl,
        to: normalized.normalized,
        timestamp: currentTime,
        changeType: changeType
      });
    }

    // Create new page object
    var newPageId = 'page_' + state.navigationHistory.length + '_' + currentTime;
    var newPage = createPageObject(newPageId, normalized.pathname, normalized.query);
    state.pages[newPageId] = newPage;
    state.currentPageId = newPageId;
    state.lastNormalizedUrl = normalized.normalized;
    state.lastUrl = window.location.href;
    state.lastChangeType = changeType;

    // Capture initial viewport for new page (not user scroll)
    handleScroll(false);
  }

  // ============================================================================
  // CLICK TRACKING
  // ============================================================================

  /**
   * Handles click events with dead-click and rage-click detection.
   * CRITICAL: Records the click event FIRST (minimal data) before any
   * complex element inspection that might throw on unusual DOM elements.
   */
  function handleClick(e) {
    if (!state.isActive) return;

    var rawTarget = e.target;
    if (!rawTarget) return;

    var currentTime = Date.now();

    // ── STEP 1: Record the click immediately with minimal safe data ──
    // This ensures the click is ALWAYS counted even if enrichment fails.
    var basicType = 'element';
    try { basicType = (rawTarget.tagName || 'div').toLowerCase(); } catch(ignored) {}

    // Increment page click count FIRST (guaranteed)
    if (state.currentPageId && state.pages[state.currentPageId]) {
      state.pages[state.currentPageId].clickCount++;

      // Record TTFA (time to first action) on first click
      if (state.pages[state.currentPageId].ttfa === null) {
        state.pages[state.currentPageId].ttfa =
          currentTime - state.pages[state.currentPageId].entryTimestamp;
      }
    }

    // Record raw event with minimal data (guaranteed to succeed)
    recordRawEvent('click', {
      elementType: basicType,
      text: '',
      ariaLabel: '',
      elementDescription: basicType,
      selector: '',
      triggeredNavigation: false
    });

    // ── STEP 2: Enrich the last recorded event with detailed data ──
    // If any of this fails, the click is still counted from Step 1.
    try {
      var target = rawTarget;

      // Walk up to find meaningful interactive parent (not SVG internals)
      var meaningful = target.closest('a, button, [role="button"], [role="link"], [role="tab"], input, select, textarea');
      if (meaningful) target = meaningful;

      var elementType = getElementType(target);
      var text = getElementText(target);
      var ariaLabel = getAccessibilityLabel(target);
      var selector = getStableSelector(target);
      var description = getElementDescription(target);

      // Detect navigation from click
      var triggeredNavigation = false;
      try {
        if (target.tagName === 'A' || target.closest('a')) {
          triggeredNavigation = true;
        }
      } catch(ignored) {}

      // Create stable key for rage click comparison
      var clickKey = elementType + '|' + (text || '').substring(0, 30);

      // Enrich the last raw event (overwrite the minimal data)
      var lastEvent = state.rawEvents[state.rawEvents.length - 1];
      if (lastEvent && lastEvent.eventType === 'click' && lastEvent.timestamp === currentTime) {
        lastEvent.elementType = elementType;
        lastEvent.text = text;
        lastEvent.ariaLabel = ariaLabel;
        lastEvent.elementDescription = description;
        lastEvent.selector = selector;
        lastEvent.triggeredNavigation = triggeredNavigation;
      }

      // ── STEP 3: Friction detection (rage clicks, dead clicks) ──
      var eventRef = {
        eventId: 'click_' + currentTime,
        elementType: elementType,
        elementDescription: description,
        text: text,
        ariaLabel: ariaLabel,
        clickKey: clickKey,
        timestamp: currentTime
      };

      // Track click history for rage-click detection
      state.clickHistory.push(eventRef);
      var recentClicks = state.clickHistory.filter(function(click) {
        return currentTime - click.timestamp < CONFIG.RAGE_CLICK_WINDOW_MS;
      });

      // Detect rage click
      if (recentClicks.length >= CONFIG.RAGE_CLICK_THRESHOLD) {
        var sameElementClicks = recentClicks.filter(function(click) {
          return click.clickKey === clickKey;
        });

        if (sameElementClicks.length >= CONFIG.RAGE_CLICK_THRESHOLD) {
          detectRageClick(description, elementType, sameElementClicks);
        }
      }

      // Clean old click history
      state.clickHistory = state.clickHistory.filter(function(click) {
        return currentTime - click.timestamp < CONFIG.RAGE_CLICK_WINDOW_MS * 2;
      });

      // Set up dead-click detection (only for certain element types)
      if (shouldDetectDeadClick(target)) {
        detectDeadClick(target, eventRef, description, elementType);
      }
    } catch (err) {
      console.warn('[FlowLensTracker] Click enrichment error (click still counted):', err);
    }

    // Reset idle timer on user interaction
    try { resetIdleTimer(); } catch(ignored) {}
  }

  /**
   * Determines if dead-click detection should run for this element
   */
  function shouldDetectDeadClick(el) {
    var elementType = getElementType(el);
    var skipTypes = ['input-text', 'textarea', 'input-search', 'input-email', 'input-password'];
    return skipTypes.indexOf(elementType) === -1;
  }

  /**
   * Detects dead clicks (clicks that don't trigger navigation or DOM mutations)
   * Observe only the clicked element's grandparent, not entire document.body
   */
  function detectDeadClick(target, eventRef, description, elementType) {
    var mutationDetected = false;

    // Observe only the clicked element's grandparent (2 levels up), not entire document.body
    var observeTarget = (target.parentElement && target.parentElement.parentElement)
      ? target.parentElement.parentElement
      : (target.parentElement || document.body);

    // Set up mutation observer
    var observer = new MutationObserver(function() {
      mutationDetected = true;
    });

    // Only watch childList (structural changes), NOT attributes (too noisy on SPAs)
    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

    state.mutationObservers.push(observer);

    // Check after timeout
    var timeoutId = setTimeout(function() {
      observer.disconnect();
      state.mutationObservers = state.mutationObservers.filter(function(o) { return o !== observer; });

      var currentUrl = window.location.href;
      var navigationOccurred = currentUrl !== state.lastUrl;

      if (!mutationDetected && !navigationOccurred) {
        // Dead click detected
        recordDeadClickSignal(eventRef, description, elementType);
      }
    }, CONFIG.DEAD_CLICK_DETECTION_TIMEOUT_MS);
  }

  /**
   * Records a rage-click friction signal
   */
  function detectRageClick(description, elementType, clicks) {
    var signal = {
      signalType: 'rage_click',
      triggeringEventRef: clicks[0],
      pageRef: state.currentPageId,
      detectionRule: CONFIG.RAGE_CLICK_THRESHOLD + '+ clicks on same element within ' + CONFIG.RAGE_CLICK_WINDOW_MS + 'ms',
      severity: FRICTION_SEVERITY.HIGH,
      timestamp: Date.now(),
      evidence: {
        elementDescription: description,
        elementType: elementType,
        clickCount: clicks.length,
        timeWindow: CONFIG.RAGE_CLICK_WINDOW_MS
      }
    };

    state.frictionSignals.push(signal);

    if (state.currentPageId && state.pages[state.currentPageId]) {
      state.pages[state.currentPageId].frictionSignals.push(signal);
    }
  }

  /**
   * Records a dead-click friction signal
   */
  function recordDeadClickSignal(eventRef, description, elementType) {
    var signal = {
      signalType: 'dead_click',
      triggeringEventRef: eventRef,
      pageRef: state.currentPageId,
      detectionRule: 'Click with no DOM mutation or navigation within 500ms',
      severity: FRICTION_SEVERITY.HIGH,
      timestamp: Date.now(),
      evidence: {
        elementDescription: description,
        elementType: elementType
      }
    };

    state.frictionSignals.push(signal);

    if (state.currentPageId && state.pages[state.currentPageId]) {
      state.pages[state.currentPageId].frictionSignals.push(signal);
    }
  }

  // ============================================================================
  // SCROLL TRACKING
  // ============================================================================

  /**
   * Handles scroll events with depth tracking
   */
  function handleScroll(isUserScroll) {
    if (!state.isActive || !state.currentPageId) return;

    var currentPage = state.pages[state.currentPageId];
    if (!currentPage) return;

    var windowHeight = window.innerHeight;
    var documentHeight = document.documentElement.scrollHeight;
    var scrollTop = window.scrollY || document.documentElement.scrollTop;

    // Calculate visible percentage (how much of the page can be seen)
    var visiblePercent = documentHeight > 0 ? Math.round((windowHeight / documentHeight) * 100) : 100;

    // If page content fits entirely in viewport, scroll depth = visible percent (100% only if truly scrolled or all visible)
    var depth;
    if (documentHeight <= windowHeight) {
      // Entire page visible without scrolling — report as 100% (user can see everything)
      depth = 100;
      currentPage.hasScrolled = true; // Content is fully visible
    } else {
      depth = Math.min(100, Math.round(((scrollTop + windowHeight) / documentHeight) * 100));
      // Only mark as scrolled if user actually scrolled (not initial page load capture)
      if (scrollTop > 10) {
        currentPage.hasScrolled = true;
      }
    }

    var timeSinceEntry = Date.now() - currentPage.entryTimestamp;

    // Only update max scroll depth if user has interacted or page is fully visible
    if (depth > currentPage.maxScrollDepth) {
      // For long pages, don't count initial viewport as "scrolled"
      if (documentHeight > windowHeight && !currentPage.hasScrolled) {
        // First load of long page — record initial visible area
        currentPage.maxScrollDepth = Math.min(depth, visiblePercent);
      } else {
        currentPage.maxScrollDepth = depth;
      }

      // Record time to 50% if first time reaching it (only if actually scrolled)
      if (currentPage.hasScrolled && currentPage.maxScrollDepth >= 50 && currentPage.timeToScroll50 === null) {
        currentPage.timeToScroll50 = timeSinceEntry;
        recordRawEvent('scroll', {
          depth: currentPage.maxScrollDepth,
          milestone: '50%',
          timeToMilestone: timeSinceEntry
        });
      }

      // Record time to 75%
      if (currentPage.hasScrolled && currentPage.maxScrollDepth >= 75 && currentPage.timeToScroll75 === null) {
        currentPage.timeToScroll75 = timeSinceEntry;
        recordRawEvent('scroll', {
          depth: currentPage.maxScrollDepth,
          milestone: '75%',
          timeToMilestone: timeSinceEntry
        });
      }
    }

    // Reset idle timer on user scroll
    if (isUserScroll !== false) {
      resetIdleTimer();
    }
  }

  // ============================================================================
  // HOVER TRACKING (for hesitation detection)
  // ============================================================================

  /**
   * Handles mouseenter on interactive elements
   */
  function handleMouseEnter(e) {
    if (!state.isActive) return;

    var target = e.target;
    if (!isInteractiveElement(target)) return;

    var selector = getStableSelector(target);
    var currentTime = Date.now();

    if (!state.hoverTracking[selector]) {
      state.hoverTracking[selector] = {
        selector: selector,
        target: target,
        elementType: getElementType(target),
        elementDescription: getElementDescription(target),
        enterTime: currentTime,
        exitTime: null,
        duration: 0
      };
    }
  }

  /**
   * Handles mouseleave on interactive elements
   */
  function handleMouseLeave(e) {
    if (!state.isActive) return;

    var target = e.target;
    if (!isInteractiveElement(target)) return;

    var selector = getStableSelector(target);
    var currentTime = Date.now();

    if (state.hoverTracking[selector]) {
      var hover = state.hoverTracking[selector];
      hover.exitTime = currentTime;
      hover.duration = currentTime - hover.enterTime;

      recordRawEvent('hover', {
        selector: selector,
        elementType: hover.elementType,
        elementDescription: hover.elementDescription,
        duration: hover.duration
      });

      // Detect hover hesitation
      if (hover.duration >= CONFIG.HOVER_HESITATION_THRESHOLD_MS) {
        detectHoverHesitation(hover);
      }

      delete state.hoverTracking[selector];
    }
  }

  /**
   * Records a hover hesitation friction signal
   */
  function detectHoverHesitation(hover) {
    var signal = {
      signalType: 'hover_hesitation',
      triggeringEventRef: hover,
      pageRef: state.currentPageId,
      detectionRule: 'Hover over interactive element for >' + CONFIG.HOVER_HESITATION_THRESHOLD_MS + 'ms',
      severity: FRICTION_SEVERITY.LOW_MEDIUM,
      timestamp: Date.now(),
      evidence: {
        elementDescription: hover.elementDescription,
        elementType: hover.elementType,
        hoverDuration: hover.duration
      }
    };

    state.frictionSignals.push(signal);

    if (state.currentPageId && state.pages[state.currentPageId]) {
      state.pages[state.currentPageId].frictionSignals.push(signal);
    }
  }

  // ============================================================================
  // IDLE DETECTION
  // ============================================================================

  /**
   * Resets the idle timer
   */
  function resetIdleTimer() {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(function() {
      detectIdleCluster();
    }, CONFIG.IDLE_THRESHOLD_MS);
  }

  /**
   * Records an idle cluster friction signal
   */
  function detectIdleCluster() {
    if (!state.isActive || !state.currentPageId) return;

    var signal = {
      signalType: 'idle_cluster',
      triggeringEventRef: null,
      pageRef: state.currentPageId,
      detectionRule: 'No interaction for >' + CONFIG.IDLE_THRESHOLD_MS + 'ms while page open',
      severity: FRICTION_SEVERITY.LOW_MEDIUM,
      timestamp: Date.now(),
      evidence: {
        idleDuration: CONFIG.IDLE_THRESHOLD_MS
      }
    };

    state.frictionSignals.push(signal);

    if (state.currentPageId && state.pages[state.currentPageId]) {
      state.pages[state.currentPageId].frictionSignals.push(signal);
    }
  }

  // ============================================================================
  // SPA NAVIGATION DETECTION
  // ============================================================================

  /**
   * Patches History API methods for SPA navigation detection
   */
  function patchHistoryAPI() {
    var originalPushState = window.history.pushState;
    var originalReplaceState = window.history.replaceState;

    window.history.pushState = function() {
      var args = Array.prototype.slice.call(arguments);
      var result = originalPushState.apply(this, args);

      setTimeout(function() {
        var normalized = normalizeUrl(window.location.href);
        var prevNormalized = state.lastNormalizedUrl;

        if (normalized.normalized !== prevNormalized) {
          // Determine change type
          var prevUrl = new URL(prevNormalized || window.location.href, window.location.origin);
          var changeType = prevUrl.pathname === normalized.pathname ? 'STEP_CHANGE' : 'PAGE_CHANGE';
          transitionToPage(changeType);
        }
      }, 0);

      return result;
    };

    window.history.replaceState = function() {
      var args = Array.prototype.slice.call(arguments);
      var result = originalReplaceState.apply(this, args);

      setTimeout(function() {
        var normalized = normalizeUrl(window.location.href);
        var prevNormalized = state.lastNormalizedUrl;

        if (normalized.normalized !== prevNormalized) {
          var prevUrl = new URL(prevNormalized || window.location.href, window.location.origin);
          var changeType = prevUrl.pathname === normalized.pathname ? 'STEP_CHANGE' : 'PAGE_CHANGE';
          transitionToPage(changeType);
        }
      }, 0);

      return result;
    };
  }

  /**
   * Listens for popstate events (browser back/forward)
   */
  function handlePopState() {
    if (!state.isActive) return;

    setTimeout(function() {
      var normalized = normalizeUrl(window.location.href);
      var prevNormalized = state.lastNormalizedUrl;

      if (normalized.normalized !== prevNormalized) {
        // Check if this is a back navigation to a previously visited page
        var isBackNav = state.navigationHistory.some(function(nav) {
          return nav.to === normalized.normalized;
        });

        if (isBackNav) {
          recordRawEvent('back_navigation', {
            fromUrl: prevNormalized,
            toUrl: normalized.normalized
          });

          // Record back navigation signal
          var signal = {
            signalType: 'back_navigation',
            triggeringEventRef: null,
            pageRef: state.currentPageId,
            detectionRule: 'User navigated back to previously visited page',
            severity: FRICTION_SEVERITY.MEDIUM,
            timestamp: Date.now(),
            evidence: {
              fromUrl: prevNormalized,
              toUrl: normalized.normalized
            }
          };

          state.frictionSignals.push(signal);
        }

        var prevUrl = new URL(prevNormalized || window.location.href, window.location.origin);
        var changeType = prevUrl.pathname === normalized.pathname ? 'STEP_CHANGE' : 'PAGE_CHANGE';
        transitionToPage(changeType);
      }
    }, 0);
  }

  /**
   * Polls URL for changes (fallback for dynamic navigation)
   */
  function startUrlPolling() {
    setInterval(function() {
      if (!state.isActive) return;

      var normalized = normalizeUrl(window.location.href);
      var prevNormalized = state.lastNormalizedUrl;

      if (normalized.normalized !== prevNormalized) {
        var prevUrl = new URL(prevNormalized || window.location.href, window.location.origin);
        var changeType = prevUrl.pathname === normalized.pathname ? 'STEP_CHANGE' : 'PAGE_CHANGE';
        transitionToPage(changeType);
      }
    }, CONFIG.URL_POLL_INTERVAL_MS);
  }

  // ============================================================================
  // TTFA AND HIGH TTFA DETECTION
  // ============================================================================

  /**
   * Detects high TTFA and records as friction signal
   */
  function detectHighTTFA() {
    if (!state.currentPageId || !state.pages[state.currentPageId]) return;

    var page = state.pages[state.currentPageId];

    if (page.ttfa && page.ttfa > CONFIG.TTFA_THRESHOLD_MS) {
      var signal = {
        signalType: 'high_ttfa',
        triggeringEventRef: null,
        pageRef: state.currentPageId,
        detectionRule: 'TTFA > ' + CONFIG.TTFA_THRESHOLD_MS + 'ms on page entry',
        severity: FRICTION_SEVERITY.MEDIUM,
        timestamp: Date.now(),
        evidence: {
          ttfa: page.ttfa,
          threshold: CONFIG.TTFA_THRESHOLD_MS
        }
      };

      state.frictionSignals.push(signal);
      page.frictionSignals.push(signal);
    }
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  /**
   * Resets all tracker state to fresh (used on clear data and before new sessions)
   */
  function resetState() {
    // Stop any existing timers/observers
    if (state.idleTimer) clearTimeout(state.idleTimer);
    for (var i = 0; i < state.mutationObservers.length; i++) {
      try { state.mutationObservers[i].disconnect(); } catch(e) {}
    }

    state.isActive = false;
    state.sessionId = null;
    state.sessionStartTime = null;
    state.sessionEndTime = null;
    state.hostname = null;
    state.currentPageId = null;
    state.rawEvents = [];
    state.pages = {};
    state.frictionSignals = [];
    state.navigationHistory = [];
    state.lastUrl = null;
    state.lastNormalizedUrl = null;
    state.lastChangeType = null;
    state.idleTimer = null;
    state.hoverTracking = {};
    state.clickHistory = [];
    state.totalStrippedParams = 0;
    state.mutationObservers = [];
    state.pendingDeadClickDetection = null;
  }

  /**
   * Starts the tracker
   */
  function start() {
    if (state.isActive) return;

    // Reset all previous state to ensure a clean session
    resetState();

    state.isActive = true;
    state.sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    state.sessionStartTime = Date.now();
    state.hostname = window.location.hostname;

    // Initialize with current page
    transitionToPage('PAGE_CHANGE');

    // Patch History API
    patchHistoryAPI();

    // Attach event listeners
    document.addEventListener('click', handleClick, true);

    // Scroll handlers — mark as user-initiated, store ref for cleanup
    state.userScrollHandler = function() { handleScroll(true); };
    document.addEventListener('scroll', state.userScrollHandler, { passive: true });
    window.addEventListener('scroll', state.userScrollHandler, { passive: true });

    // Also attach to SPA scroll containers (e.g. LinkedIn main)
    state.containerScrollEls = [];
    var containerSelectors = ['main', '[role="main"]', '.scaffold-layout__main', '#main-content'];
    for (var i = 0; i < containerSelectors.length; i++) {
      var sel = containerSelectors[i];
      var el = document.querySelector(sel);
      if (el && el !== document.documentElement && el !== document.body) {
        el.addEventListener('scroll', state.userScrollHandler, { passive: true });
        state.containerScrollEls.push(el);
      }
    }

    // Capture initial scroll position after a brief delay (not user-initiated)
    setTimeout(function() { handleScroll(false); }, 300);

    document.addEventListener('mouseenter', handleMouseEnter, true);
    document.addEventListener('mouseleave', handleMouseLeave, true);
    window.addEventListener('popstate', handlePopState);

    // Initial scroll capture (not user-initiated)
    handleScroll(false);

    // Start URL polling
    startUrlPolling();

    // Initialize idle timer
    resetIdleTimer();

    console.log('[FlowLensTracker] Started', { sessionId: state.sessionId });
  }

  /**
   * Stops the tracker
   */
  function stop() {
    if (!state.isActive) return;

    state.isActive = false;
    state.sessionEndTime = Date.now();

    // Close current page
    if (state.currentPageId && state.pages[state.currentPageId]) {
      var page = state.pages[state.currentPageId];
      page.exitTimestamp = state.sessionEndTime;
      page.timeSpent = state.sessionEndTime - page.entryTimestamp;

      // Detect high TTFA if applicable
      detectHighTTFA();
    }

    // Clean up event listeners
    document.removeEventListener('click', handleClick, true);
    if (state.userScrollHandler) {
      document.removeEventListener('scroll', state.userScrollHandler);
      window.removeEventListener('scroll', state.userScrollHandler);
      // Clean up container scroll listeners
      if (state.containerScrollEls) {
        for (var i = 0; i < state.containerScrollEls.length; i++) {
          state.containerScrollEls[i].removeEventListener('scroll', state.userScrollHandler);
        }
        state.containerScrollEls = [];
      }
    }
    document.removeEventListener('mouseenter', handleMouseEnter, true);
    document.removeEventListener('mouseleave', handleMouseLeave, true);
    window.removeEventListener('popstate', handlePopState);

    // Clean up timers
    if (state.idleTimer) clearTimeout(state.idleTimer);

    // Disconnect mutation observers
    for (var i = 0; i < state.mutationObservers.length; i++) {
      state.mutationObservers[i].disconnect();
    }
    state.mutationObservers = [];

    console.log('[FlowLensTracker] Stopped', { sessionId: state.sessionId });
  }

  /**
   * Returns aggregated tracker data
   */
  function getData() {
    try {
      if (!state.sessionId) {
        return {
          error: 'Tracker not initialized',
          session: null,
          rawEvents: [],
          pages: [],
          signals: [],
          navigations: [],
          metrics: {}
        };
      }

      // Snapshot current time for live calculations
      var now = Date.now();
      var effectiveEndTime = state.sessionEndTime || now;

      // Build pages array, filling in live data for current page
      var pages = Object.keys(state.pages).map(function(pageId) {
        var p = state.pages[pageId];
        if (p.pageId === state.currentPageId && !p.exitTimestamp) {
          var livePage = {};
          for (var key in p) {
            if (p.hasOwnProperty(key)) {
              livePage[key] = p[key];
            }
          }
          livePage.timeSpent = now - p.entryTimestamp;
          livePage.exitTimestamp = null;
          return livePage;
        }
        return p;
      });

      var totalPages = pages.length;
      var totalSteps = state.navigationHistory.filter(function(n) {
        return n.changeType === 'STEP_CHANGE';
      }).length;
      var totalClicks = state.rawEvents.filter(function(e) {
        return e.eventType === 'click';
      }).length;

      // Calculate unique pages
      var uniquePathnames = {};
      for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        uniquePathnames[p.pathname] = true;
      }
      var uniquePageCount = Object.keys(uniquePathnames).length;

      // Build unique page list
      var uniquePageList = Object.keys(uniquePathnames);

      var rageClickSignals = state.frictionSignals.filter(function(s) {
        return s.signalType === 'rage_click';
      });
      var deadClickSignals = state.frictionSignals.filter(function(s) {
        return s.signalType === 'dead_click';
      });
      var backNavSignals = state.frictionSignals.filter(function(s) {
        return s.signalType === 'back_navigation';
      });
      var hoverHesitationSignals = state.frictionSignals.filter(function(s) {
        return s.signalType === 'hover_hesitation';
      });
      var idleClusterSignals = state.frictionSignals.filter(function(s) {
        return s.signalType === 'idle_cluster';
      });

      var totalTimeSpent = pages.reduce(function(sum, p) {
        // For active page with no exit time, compute live timeSpent
        if (p.exitTimestamp === null) {
          return sum + (Date.now() - p.entryTimestamp);
        }
        return sum + (p.timeSpent || 0);
      }, 0);
      var avgTimePerPage = totalPages > 0 ? Math.round(totalTimeSpent / totalPages) : 0;

      var ttfas = pages.filter(function(p) { return p.ttfa !== null; }).map(function(p) { return p.ttfa; });
      var avgTTFA = ttfas.length > 0 ? Math.round(ttfas.reduce(function(a, b) { return a + b; }, 0) / ttfas.length) : 0;

      var scrollDepths = pages.map(function(p) { return p.maxScrollDepth; });
      var avgScrollDepth = scrollDepths.length > 0
        ? Math.round(scrollDepths.reduce(function(a, b) { return a + b; }, 0) / scrollDepths.length)
        : 0;

      // Sanitize function: strip DOM element refs (they break JSON.stringify)
      function sanitizeSignal(sig) {
        return {
          signalType: sig.signalType,
          pageRef: sig.pageRef,
          detectionRule: sig.detectionRule,
          severity: sig.severity,
          timestamp: sig.timestamp,
          evidence: sig.evidence || {}
        };
      }

      // Build serializable click actions per page for richer reporting
      function buildPageClickActions(p) {
        var clicks = state.rawEvents.filter(function(e) {
          return e.eventType === 'click' && e.pageId === p.pageId;
        });
        return clicks.map(function(c) {
          return {
            text: c.text || '',
            ariaLabel: c.ariaLabel || '',
            elementType: c.elementType || '',
            elementDescription: c.elementDescription || '',
            selector: c.selector || '',
            triggeredNavigation: c.triggeredNavigation || false,
            timestamp: c.timestamp
          };
        });
      }

      return {
        session: {
          id: state.sessionId,
          startTime: state.sessionStartTime,
          endTime: effectiveEndTime,
          duration: effectiveEndTime - state.sessionStartTime,
          hostname: state.hostname,
          url: window.location.href
        },
        // Strip DOM element refs from raw events (only keep serializable fields)
        rawEvents: state.rawEvents.map(function(e) {
          return {
            sessionId: e.sessionId,
            timestamp: e.timestamp,
            eventType: e.eventType,
            normalizedUrl: e.normalizedUrl,
            pageTitle: e.pageTitle,
            pathname: e.pathname,
            pageId: e.pageId,
            elementType: e.elementType || undefined,
            text: e.text || undefined,
            ariaLabel: e.ariaLabel || undefined,
            elementDescription: e.elementDescription || undefined,
            selector: e.selector || undefined,
            triggeredNavigation: e.triggeredNavigation || undefined,
            depth: e.depth || undefined,
            fromUrl: e.fromUrl || undefined,
            toUrl: e.toUrl || undefined,
            changeType: e.changeType || undefined
          };
        }),
        pages: pages.map(function(p) {
          return {
            pageId: p.pageId,
            pathname: p.pathname,
            queryState: p.queryState,
            entryTimestamp: p.entryTimestamp,
            exitTimestamp: p.exitTimestamp,
            timeSpent: p.exitTimestamp === null ? Date.now() - p.entryTimestamp : p.timeSpent,
            maxScrollDepth: p.maxScrollDepth,
            hasScrolled: p.hasScrolled || false,
            timeToScroll50: p.timeToScroll50,
            timeToScroll75: p.timeToScroll75,
            ttfa: p.ttfa,
            clickCount: p.clickCount,
            clickActions: buildPageClickActions(p),
            frictionSignalCount: p.frictionSignals.length,
            frictionSignals: p.frictionSignals.map(sanitizeSignal)
          };
        }),
        signals: state.frictionSignals.map(sanitizeSignal),
        navigations: state.navigationHistory,
        metrics: {
          totalPages: totalPages,
          uniquePages: uniquePageCount,
          uniquePageList: uniquePageList,
          totalSteps: totalSteps,
          totalClicks: totalClicks,
          rageClickCount: rageClickSignals.length,
          deadClickCount: deadClickSignals.length,
          backNavigationCount: backNavSignals.length,
          hoverHesitationCount: hoverHesitationSignals.length,
          idleClusterCount: idleClusterSignals.length,
          totalFrictionSignals: state.frictionSignals.length,
          avgTimePerPage: avgTimePerPage,
          avgTTFA: avgTTFA,
          avgScrollDepth: avgScrollDepth,
          totalStrippedParams: state.totalStrippedParams
        }
      };
    } catch (error) {
      console.error('[FlowLensTracker] getData() error:', error);
      return {
        error: 'Failed to retrieve tracker data: ' + (error.message || error),
        session: state.sessionId ? { id: state.sessionId } : null,
        rawEvents: [],
        pages: [],
        signals: [],
        navigations: [],
        metrics: {}
      };
    }
  }

  /**
   * Returns whether tracker is currently active
   */
  function isActive() {
    return state.isActive;
  }

  // ============================================================================
  // EXPORT PUBLIC API
  // ============================================================================

  window.FlowLensTracker = Object.freeze({
    start: start,
    stop: stop,
    getData: getData,
    isActive: isActive,
    reset: resetState
  });

  console.log('[FlowLensTracker] Loaded and ready. Call window.FlowLensTracker.start() to begin tracking.');
})();
