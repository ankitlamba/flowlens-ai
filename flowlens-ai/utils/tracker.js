/**
 * FlowLens AI — Core Tracking Engine
 * Tracks clicks, scrolls, navigation, rage clicks, dead clicks,
 * per-URL metrics, scroll depth, fold reach, and engagement scoring.
 */

const FlowLensTracker = (() => {
  // ── State ──
  let isRecording = false;
  let sessionData = {
    startTime: null,
    url: window.location.href,
    hostname: window.location.hostname,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pages: [],
    clicks: [],
    scrollDepths: {},
    rageClicks: [],
    deadClicks: [],
    navigations: [],
    urlMetrics: {}
  };

  let currentPageEntry = null;
  let clickBuffer = [];
  let maxScrollDepth = 0;
  let maxFoldReached = 1;

  // ── Helpers ──
  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return '#' + el.id;
    let path = [];
    while (el && el !== document.body) {
      let tag = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) tag += '.' + cls;
      }
      path.unshift(tag);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  function getElementText(el) {
    return (el.textContent || el.innerText || '').trim().substring(0, 80);
  }

  function getElementRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    if (role) return role;
    if (tag === 'a') return 'link';
    if (tag === 'button' || (tag === 'input' && type === 'submit')) return 'button';
    if (tag === 'input') return 'input-' + (type || 'text');
    if (tag === 'select') return 'dropdown';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'img') return 'image';
    if (['h1','h2','h3','h4','h5','h6'].includes(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    return tag;
  }

  function getUrlPath(url) {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch (e) {
      return url;
    }
  }

  function calculateCurrentFold() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const vh = window.innerHeight;
    return Math.max(1, Math.floor(scrollTop / vh) + 1);
  }

  function getOrCreateUrlMetrics(url, title) {
    const urlPath = getUrlPath(url);
    if (!sessionData.urlMetrics[urlPath]) {
      sessionData.urlMetrics[urlPath] = {
        url: url,
        title: title || document.title,
        visitCount: 0,
        totalTimeSpent: 0,
        avgTimeSpent: 0,
        maxScrollDepth: 0,
        maxFoldReached: 0,
        clickCount: 0,
        rageClickCount: 0,
        deadClickCount: 0,
        firstVisitAt: Date.now(),
        lastVisitAt: Date.now()
      };
    }
    return sessionData.urlMetrics[urlPath];
  }

  function calculateEngagementScore(metrics) {
    const timeSec = (metrics.totalTimeSpent || 0) / 1000;
    const clicks = metrics.clickCount || 0;
    const scroll = metrics.maxScrollDepth || 0;
    return Math.round((timeSec * 0.3 + clicks * 0.5 + scroll * 0.2) * 100) / 100;
  }

  // ── Page Tracking ──
  function startPageTracking() {
    const url = window.location.href;
    const title = document.title;

    currentPageEntry = {
      url: url,
      urlPath: getUrlPath(url),
      title: title,
      enteredAt: Date.now(),
      exitedAt: null,
      scrollDepth: 0,
      foldReached: 1,
      clickCount: 0
    };

    const urlMetrics = getOrCreateUrlMetrics(url, title);
    urlMetrics.visitCount++;

    maxScrollDepth = 0;
    maxFoldReached = 1;
  }

  function endPageTracking() {
    if (!currentPageEntry) return;

    const now = Date.now();
    currentPageEntry.exitedAt = now;
    currentPageEntry.scrollDepth = maxScrollDepth;
    currentPageEntry.foldReached = maxFoldReached;
    currentPageEntry.timeSpent = now - currentPageEntry.enteredAt;

    sessionData.pages.push({ ...currentPageEntry });

    // Finalize URL metrics for this page
    const urlMetrics = getOrCreateUrlMetrics(currentPageEntry.url, currentPageEntry.title);
    urlMetrics.totalTimeSpent += currentPageEntry.timeSpent;
    urlMetrics.avgTimeSpent = Math.round(urlMetrics.totalTimeSpent / urlMetrics.visitCount);
    urlMetrics.maxScrollDepth = Math.max(urlMetrics.maxScrollDepth, maxScrollDepth);
    urlMetrics.maxFoldReached = Math.max(urlMetrics.maxFoldReached, maxFoldReached);
    urlMetrics.lastVisitAt = now;

    currentPageEntry = null;
  }

  // ── Click Tracking ──
  function handleClick(e) {
    if (!isRecording) return;

    const target = e.target;
    const now = Date.now();
    const url = window.location.href;
    const urlPath = getUrlPath(url);

    const clickData = {
      timestamp: now,
      x: e.clientX,
      y: e.clientY,
      pageX: e.pageX,
      pageY: e.pageY,
      selector: getSelector(target),
      text: getElementText(target),
      role: getElementRole(target),
      url: url,
      urlPath: urlPath,
      pageTitle: document.title
    };

    sessionData.clicks.push(clickData);
    if (currentPageEntry) currentPageEntry.clickCount++;

    // Update URL metrics
    const urlMetrics = getOrCreateUrlMetrics(url, document.title);
    urlMetrics.clickCount++;

    // ── Rage Click Detection (3+ clicks within 1s near same spot) ──
    clickBuffer.push({ x: e.clientX, y: e.clientY, time: now, selector: clickData.selector });
    clickBuffer = clickBuffer.filter(function(c) { return now - c.time < 1000; });

    if (clickBuffer.length >= 3) {
      const first = clickBuffer[0];
      const allClose = clickBuffer.every(function(c) {
        return Math.abs(c.x - first.x) < 50 && Math.abs(c.y - first.y) < 50;
      });
      if (allClose) {
        sessionData.rageClicks.push({
          timestamp: now,
          selector: clickData.selector,
          text: clickData.text,
          role: clickData.role,
          url: url,
          urlPath: urlPath,
          pageTitle: document.title,
          clickCount: clickBuffer.length
        });
        urlMetrics.rageClickCount++;
        clickBuffer = [];
      }
    }

    // ── Dead Click Detection (no DOM change within 500ms) ──
    const snapshotUrl = window.location.href;
    const observer = new MutationObserver(function() { observer._changed = true; });
    observer._changed = false;
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    setTimeout(function() {
      observer.disconnect();
      if (!observer._changed && window.location.href === snapshotUrl) {
        var skip = ['input-text', 'input-email', 'input-password', 'input-search', 'textarea', 'dropdown'];
        if (skip.indexOf(clickData.role) === -1) {
          sessionData.deadClicks.push({
            timestamp: now,
            selector: clickData.selector,
            text: clickData.text,
            role: clickData.role,
            url: url,
            urlPath: urlPath,
            pageTitle: document.title
          });
          urlMetrics.deadClickCount++;
        }
      }
    }, 500);
  }

  // ── Scroll Tracking ──
  function handleScroll() {
    if (!isRecording) return;

    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ) - window.innerHeight;

    var depth = docHeight > 0 ? Math.round((scrollTop / docHeight) * 100) : 0;
    depth = Math.min(depth, 100);

    // Update local max
    if (depth > maxScrollDepth) maxScrollDepth = depth;

    var fold = calculateCurrentFold();
    if (fold > maxFoldReached) maxFoldReached = fold;

    // Update current page entry in real-time
    if (currentPageEntry) {
      currentPageEntry.scrollDepth = maxScrollDepth;
      currentPageEntry.foldReached = maxFoldReached;
    }

    // Update URL metrics in real-time (not just on endPageTracking)
    var url = window.location.href;
    var urlPath = getUrlPath(url);
    var urlMetrics = getOrCreateUrlMetrics(url, document.title);
    urlMetrics.maxScrollDepth = Math.max(urlMetrics.maxScrollDepth, maxScrollDepth);
    urlMetrics.maxFoldReached = Math.max(urlMetrics.maxFoldReached, maxFoldReached);

    // Also store per-URL scroll depth
    if (!sessionData.scrollDepths[urlPath]) sessionData.scrollDepths[urlPath] = 0;
    sessionData.scrollDepths[urlPath] = Math.max(sessionData.scrollDepths[urlPath], depth);
  }

  // ── Navigation Tracking ──
  let lastUrl = window.location.href;

  function checkUrlChange() {
    if (!isRecording) return;
    var currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      sessionData.navigations.push({
        from: lastUrl,
        to: currentUrl,
        fromPath: getUrlPath(lastUrl),
        toPath: getUrlPath(currentUrl),
        timestamp: Date.now()
      });
      endPageTracking();
      startPageTracking();
      lastUrl = currentUrl;
    }
  }

  let urlPollInterval = null;

  function patchHistoryMethod(method) {
    var original = history[method];
    history[method] = function() {
      var result = original.apply(this, arguments);
      checkUrlChange();
      return result;
    };
  }

  // ── Public API ──
  function start() {
    if (isRecording) return;
    isRecording = true;

    sessionData.startTime = Date.now();
    sessionData.url = window.location.href;
    sessionData.hostname = window.location.hostname;
    sessionData.viewportWidth = window.innerWidth;
    sessionData.viewportHeight = window.innerHeight;
    sessionData.pages = [];
    sessionData.clicks = [];
    sessionData.scrollDepths = {};
    sessionData.rageClicks = [];
    sessionData.deadClicks = [];
    sessionData.navigations = [];
    sessionData.urlMetrics = {};
    clickBuffer = [];

    startPageTracking();
    lastUrl = window.location.href;

    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('popstate', checkUrlChange);
    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
    urlPollInterval = setInterval(checkUrlChange, 500);
  }

  function stop() {
    if (!isRecording) return;
    isRecording = false;
    endPageTracking();

    document.removeEventListener('click', handleClick, true);
    window.removeEventListener('scroll', handleScroll);
    window.removeEventListener('popstate', checkUrlChange);
    if (urlPollInterval) clearInterval(urlPollInterval);
    urlPollInterval = null;
  }

  function getData() {
    // Include current page even if endPageTracking hasn't been called yet
    var allPages = sessionData.pages.slice();
    if (currentPageEntry && isRecording) {
      var livePage = {
        url: currentPageEntry.url,
        urlPath: currentPageEntry.urlPath,
        title: currentPageEntry.title,
        enteredAt: currentPageEntry.enteredAt,
        exitedAt: Date.now(),
        scrollDepth: maxScrollDepth,
        foldReached: maxFoldReached,
        clickCount: currentPageEntry.clickCount,
        timeSpent: Date.now() - currentPageEntry.enteredAt
      };
      allPages.push(livePage);
    }

    // Add engagement scores to URL metrics
    var urlMetricsWithScores = {};
    for (var urlPath in sessionData.urlMetrics) {
      var m = sessionData.urlMetrics[urlPath];
      // For current page, also include live time
      if (currentPageEntry && isRecording && urlPath === getUrlPath(currentPageEntry.url)) {
        var liveTime = Date.now() - currentPageEntry.enteredAt;
        m = Object.assign({}, m, {
          totalTimeSpent: m.totalTimeSpent + liveTime,
          avgTimeSpent: Math.round((m.totalTimeSpent + liveTime) / m.visitCount)
        });
      }
      urlMetricsWithScores[urlPath] = Object.assign({}, m, {
        engagementScore: calculateEngagementScore(m)
      });
    }

    // Average scroll depth
    var depths = Object.values(sessionData.scrollDepths);
    var avgScrollDepth = depths.length > 0
      ? Math.round(depths.reduce(function(a, b) { return a + b; }, 0) / depths.length)
      : 0;

    return {
      startTime: sessionData.startTime,
      url: sessionData.url,
      hostname: sessionData.hostname,
      viewportWidth: sessionData.viewportWidth,
      viewportHeight: sessionData.viewportHeight,
      pages: allPages,
      clicks: sessionData.clicks,
      scrollDepths: sessionData.scrollDepths,
      rageClicks: sessionData.rageClicks,
      deadClicks: sessionData.deadClicks,
      navigations: sessionData.navigations,
      urlMetrics: urlMetricsWithScores,
      endTime: Date.now(),
      totalDuration: Date.now() - (sessionData.startTime || Date.now()),
      totalClicks: sessionData.clicks.length,
      totalPages: allPages.length,
      totalRageClicks: sessionData.rageClicks.length,
      totalDeadClicks: sessionData.deadClicks.length,
      avgScrollDepthAcrossPages: avgScrollDepth
    };
  }

  function isActive() {
    return isRecording;
  }

  return { start: start, stop: stop, getData: getData, isActive: isActive };
})();
