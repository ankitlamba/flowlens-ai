/**
 * FlowLens AI — Report Renderer
 * External file required by Manifest V3 CSP (no inline scripts allowed).
 */

var currentReport = null;

document.addEventListener('DOMContentLoaded', function() {
    chrome.storage.local.get('flowlens_reports', function(result) {
        var reports = result.flowlens_reports || [];

        if (reports.length === 0) {
            document.querySelector('.container').innerHTML =
                '<p style="padding:60px;text-align:center;color:#787774;">No reports found. Record a session first.</p>';
            return;
        }

        // Find by URL param or use latest
        var params = new URLSearchParams(window.location.search);
        var id = params.get('id');
        if (id) currentReport = reports.find(function(r) { return r.id === id; });
        if (!currentReport) currentReport = reports[reports.length - 1];

        try {
            render(currentReport);
            setupButtons();
        } catch (e) {
            console.error('Report render error:', e);
            document.querySelector('.container').innerHTML =
                '<p style="padding:60px;text-align:center;color:#eb5757;">Error rendering report: ' + e.message + '</p>';
        }
    });
});

function render(report) {
    var tracking = report.trackingData || {};
    var data = report.report || {};
    var scores = data.scores || {};

    // Header
    setText('hostname', report.hostname || 'Unknown');
    setText('date', new Date(report.timestamp).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    }));
    setText('mode-badge', (report.mode || 'offline').toUpperCase());

    // Scores
    setScore('navigation', scores.navigation);
    setScore('clarity', scores.clarity);
    setScore('speed', scores.speedFeel);
    setScore('accessibility', scores.accessibility);
    setScore('overall', scores.overall);

    // Summary
    setText('summary-text', data.summary || 'No summary available.');

    // Stats
    setText('stat-clicks', tracking.totalClicks || 0);
    setText('stat-pages', tracking.totalPages || 0);
    setText('stat-rage-clicks', tracking.totalRageClicks || 0);
    setText('stat-dead-clicks', tracking.totalDeadClicks || 0);
    setText('stat-scroll-depth', Math.round(tracking.avgScrollDepthAcrossPages || 0) + '%');
    setText('stat-navigations', tracking.totalNavigations || 0);

    // Duration
    var start = typeof tracking.startTime === 'string' ? parseInt(tracking.startTime) : (tracking.startTime || 0);
    var end = tracking.endTime || Date.now();
    setText('stat-duration', fmtDuration(end - start));

    // Unique pages count
    var urlMetrics = tracking.urlMetrics || {};
    setText('stat-unique-pages', Object.keys(urlMetrics).length || tracking.totalPages || 0);

    // Journey flow
    renderJourney(tracking);

    // URL table
    renderUrlTable(urlMetrics);

    // Pain points
    renderPainPoints(data.painPoints || []);

    // Suggestions
    renderSuggestions(data.suggestions || []);
}

function setScore(type, score) {
    var el = document.getElementById('score-' + type + '-value');
    if (!el) return;
    var val = (score !== undefined && score !== null) ? Math.round(score) : '-';
    el.textContent = val;

    // Color class
    if (typeof val === 'number') {
        el.className = 'score-number';
        if (val < 5) el.classList.add('low');
        else if (val < 7) el.classList.add('medium');
        else if (val < 9) el.classList.add('good');
        else el.classList.add('great');
    }
}

function renderJourney(tracking) {
    var container = document.getElementById('journey-flow');
    var pages = tracking.pages || [];
    var navs = tracking.navigations || [];

    if (pages.length === 0 && navs.length === 0) {
        container.innerHTML = '<p class="empty">No navigation recorded.</p>';
        return;
    }

    var steps = [];
    if (navs.length > 0) {
        steps.push(shortUrl(navs[0].from || navs[0].fromPath || ''));
        navs.forEach(function(n) {
            var to = shortUrl(n.to || n.toPath || '');
            if (steps[steps.length - 1] !== to) steps.push(to);
        });
    } else {
        pages.forEach(function(p) {
            steps.push((p.title || shortUrl(p.url || '')).substring(0, 30));
        });
    }

    var html = '<div class="flow-steps">';
    steps.forEach(function(s, i) {
        html += '<div class="flow-node">' + esc(s) + '</div>';
        if (i < steps.length - 1) html += '<div class="flow-arrow">&#8594;</div>';
    });
    html += '</div>';
    container.innerHTML = html;
}

function renderUrlTable(urlMetrics) {
    var tbody = document.getElementById('url-metrics-body');
    var keys = Object.keys(urlMetrics);

    if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty">No URL data.</td></tr>';
        return;
    }

    // Sort by engagement
    var sorted = keys.map(function(k) { return urlMetrics[k]; })
        .sort(function(a, b) { return (b.engagementScore || 0) - (a.engagementScore || 0); });

    var html = '';
    sorted.forEach(function(m) {
        var eng = Math.min(Math.round((m.engagementScore || 0) * 10), 100);
        html += '<tr>' +
            '<td class="url-col">' + esc(shortUrl(m.url || '')) + '</td>' +
            '<td class="title-col">' + esc(m.title || '-') + '</td>' +
            '<td>' + (m.visitCount || 0) + '</td>' +
            '<td>' + fmtDuration(m.totalTimeSpent || 0) + '</td>' +
            '<td>' + Math.round(m.maxScrollDepth || 0) + '%</td>' +
            '<td>' + (m.maxFoldReached || 1) + '</td>' +
            '<td>' + (m.clickCount || 0) + '</td>' +
            '<td>' + (m.rageClickCount || 0) + '</td>' +
            '<td>' + (m.deadClickCount || 0) + '</td>' +
            '<td class="engagement-cell"><div class="engagement-bar" style="width:' + eng + '%"></div></td>' +
            '</tr>';
    });
    tbody.innerHTML = html;
}

function renderPainPoints(points) {
    var container = document.getElementById('pain-points-list');

    if (points.length === 0) {
        container.innerHTML = '<p class="empty">No pain points identified.</p>';
        return;
    }

    var html = '<ul class="pain-list">';
    points.forEach(function(p) {
        var sev = (p.severity || 'low').toLowerCase();
        html += '<li class="pain-item">' +
            '<div class="severity-dot ' + sev + '"></div>' +
            '<div class="pain-content">' +
            '<div class="pain-title">' + esc(p.title || 'Issue') + '</div>' +
            '<div class="pain-desc">' + esc(p.description || '') + '</div>' +
            (p.evidence ? '<div class="pain-evidence">' + esc(p.evidence) + '</div>' : '') +
            '</div>' +
            '<span class="severity-tag ' + sev + '">' + sev + '</span>' +
            '</li>';
    });
    html += '</ul>';
    container.innerHTML = html;
}

function renderSuggestions(suggestions) {
    var container = document.getElementById('suggestions-list');

    if (suggestions.length === 0) {
        container.innerHTML = '<p class="empty">No suggestions.</p>';
        return;
    }

    var html = '<ul class="suggestion-list">';
    suggestions.forEach(function(s, i) {
        var impact = (s.impact || 'medium').toLowerCase();
        var effort = (s.effort || 'medium').toLowerCase();
        html += '<li class="suggestion-item">' +
            '<div class="suggestion-number">' + (i + 1) + '</div>' +
            '<div class="suggestion-content">' +
            '<div class="suggestion-title">' + esc(s.title || 'Suggestion') + '</div>' +
            '<div class="suggestion-desc">' + esc(s.description || '') + '</div>' +
            '<div class="suggestion-tags">' +
            '<span class="tag tag-impact-' + impact + '">Impact: ' + impact + '</span>' +
            '<span class="tag tag-effort-' + effort + '">Effort: ' + effort + '</span>' +
            '</div>' +
            '</div>' +
            '</li>';
    });
    html += '</ul>';
    container.innerHTML = html;
}

function setupButtons() {
    var pdf = document.getElementById('exportPdf');
    var json = document.getElementById('exportJson');
    var share = document.getElementById('shareLink');

    if (pdf) pdf.addEventListener('click', function() { window.print(); });

    if (json) json.addEventListener('click', function() {
        if (!currentReport) return;
        var blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'flowlens-report-' + currentReport.id + '.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    if (share) share.addEventListener('click', function() {
        if (!currentReport) return;
        var link = window.location.origin + window.location.pathname + '?id=' + currentReport.id;
        navigator.clipboard.writeText(link).then(function() {
            share.textContent = 'Copied!';
            setTimeout(function() { share.textContent = 'Copy Link'; }, 1500);
        });
    });
}

// ── Utilities ──

function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
}

function fmtDuration(ms) {
    if (!ms || ms < 0) return '0s';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
}

function shortUrl(url) {
    try {
        var u = new URL(url);
        return u.pathname === '/' ? u.hostname : u.pathname;
    } catch (e) {
        return url && url.length > 35 ? url.substring(0, 35) + '...' : (url || '-');
    }
}

function esc(text) {
    var d = document.createElement('div');
    d.textContent = String(text || '');
    return d.innerHTML;
}
