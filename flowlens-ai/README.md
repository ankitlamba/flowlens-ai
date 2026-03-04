# FlowLens AI

**AI-powered Chrome extension that tracks user journeys and generates product teardown reports.**

Browse any website, record your session, and get an instant AI-generated analysis with UX pain points, improvement suggestions, and product scores.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green?logo=googlechrome) ![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue) ![AI Powered](https://img.shields.io/badge/AI-Powered-purple)

---

## What It Does

FlowLens AI sits in your browser and watches how you interact with any website. It tracks:

- **Click patterns** — what you click, where, and when
- **Page navigation** — how you move between pages (works with SPAs too)
- **Rage clicks** — 3+ rapid clicks on the same element (signal of frustration)
- **Dead clicks** — clicks that do nothing (broken buttons, misleading UI)
- **Scroll depth** — how far down each page you scroll
- **Time on page** — dwell time per page

Then it sends this data to Claude AI (Anthropic) and generates a **full product teardown report** with:

- Executive summary
- Visual user journey flowchart (Mermaid.js)
- Pain points with severity ratings
- Actionable UX improvement suggestions
- Product scores (Navigation, Clarity, Speed, Accessibility)

## Why This Exists

As a PM, I do product teardowns constantly — analyzing competitor flows, identifying UX issues, presenting findings to teams. This tool automates the data collection and initial analysis, so I can focus on the insights.

This is **not** a ChatGPT wrapper. It requires browser-level access to track real user behavior that no chatbot can observe.

---

## Installation

### From Source (Developer Mode)

1. Clone this repo:
   ```bash
   git clone https://github.com/ankitlamba/flowlens-ai.git
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top right)

4. Click **Load unpacked** and select the `flowlens-ai` folder

5. Pin the FlowLens AI extension to your toolbar

### Set Up API Key

1. You'll need an [Anthropic API key](https://console.anthropic.com/)
2. Click the FlowLens extension icon
3. The extension will prompt you to enter your API key on first use
4. Your key is stored locally and never sent anywhere except Anthropic's API

---

## Usage

1. **Click the FlowLens icon** in your toolbar
2. **Hit "Start Recording"** — the extension begins tracking
3. **Browse naturally** — visit pages, click around, use the product as a real user would
4. **Hit "Stop Recording"** when done
5. **Click "Generate Teardown"** — AI analyzes your session
6. **View your report** — opens in a new tab with full analysis

### Pro Tips

- Record for at least 2-3 minutes for meaningful data
- Visit multiple pages to get a richer journey map
- Try to complete a real task (checkout flow, signup, search) for best results
- Rage click intentionally on broken elements to test detection

---

## Report Includes

| Section | What You Get |
|---------|-------------|
| Executive Summary | 2-3 sentence overview of the product's UX |
| Journey Flow | Mermaid.js flowchart of your page-to-page navigation |
| Pain Points | Issues found, with severity (High/Medium/Low) and evidence |
| Suggestions | Specific UX improvements with impact and effort ratings |
| Scores | 1-10 ratings for Navigation, Clarity, Speed Feel, Accessibility |

---

## Tech Stack

- **Chrome Extension Manifest V3** — modern extension architecture
- **Vanilla JavaScript** — no frameworks, fast and lightweight
- **Claude API (Anthropic)** — AI-powered analysis
- **Mermaid.js** — user journey flow visualization
- **chrome.storage.local** — local data persistence

---

## Project Structure

```
flowlens-ai/
├── manifest.json          # Extension config (Manifest V3)
├── popup/                 # Extension popup UI
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content/               # Injected into web pages
│   └── content.js
├── background/            # Service worker
│   └── background.js
├── report/                # Teardown report page
│   ├── report.html
│   ├── report.css
│   └── report.js
├── utils/                 # Core tracking engine
│   └── tracker.js
└── icons/                 # Extension icons
```

---

## Privacy

- All tracking data stays **local** on your machine
- Data is only sent to Anthropic's API when you explicitly click "Generate Teardown"
- No analytics, no telemetry, no third-party tracking
- Your API key is stored locally in chrome.storage

---

## Roadmap

- [ ] Chrome Web Store listing
- [ ] Export reports as PDF
- [ ] Heatmap overlay on pages
- [ ] Compare multiple sessions
- [ ] Team sharing via link
- [ ] Support for more AI providers

---

## Built By

**Ankit Lamba** — Product Manager building AI-powered tools.

[LinkedIn](https://linkedin.com/in/ankitlamba) | [GitHub](https://github.com/ankitlamba)

---

## License

MIT License — use it, fork it, build on it.
