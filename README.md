# VioEdu QA Assistant

**Language:** English · [Tiếng Việt](README_VIETNAMESE.md)

Chrome extension for authorized testing of VioEdu exercises. It detects question types, sends prompts to a selected AI provider, and can apply answers for QA workflows.

## Providers

- **Vireonix.ai** — default provider; service limits may apply.
- **OpenRouter** — enter an API key; default model is `openrouter/free`.
- **Groq** — enter a Groq API key; default model is `openai/gpt-oss-120b`. Free-tier availability and limits are controlled by Groq.

API credentials are stored in `chrome.storage.local` in the user's browser. Question text and answer choices are sent to the selected AI provider. Do not use this tool with personal, confidential, or student data unless you have permission to share that data with the provider.

## Load in Chrome for development

1. Create `private-config.js` from `private-config.example.js` and set internal staff-auth values. Keep the real file private.
2. Run `node scripts/compute-integrity.js` after changing extension files.
3. Open `chrome://extensions/`, enable **Developer mode**, choose **Load unpacked**, and select this repository directory.
4. Set the provider and API key in the extension popup or page HUD.

## Automated ZIP builds

GitHub Actions builds a ZIP from the extension source on pushes to `main`, version tags (`v*`), and manual runs. Pushes and manual runs publish a downloadable workflow artifact; a version tag also attaches the ZIP to a GitHub Release.

To publish a release, push a tag such as `v1.8.0` after pushing the source to GitHub.

The staff-key signing secret is required for staff-key validation and minting. Keep it out of source control. Key generation also requires `VIOEDU_STAFF_KEY_SECRET` in the environment; see `scripts/generate-staff-keys.js`.

## Project files

- `background.js` — provider requests, staff authentication, integrity checks.
- `content.js` / `content.css` — page detection, solver UI, and answer application.
- `popup.html` / `popup.js` — extension settings.
- `interceptor.js` — observes VioEdu question API responses for QA parsing.
- `scripts/compute-integrity.js` — regenerates pinned file hashes.

## Repository policy

This repository is proprietary and intended for authorized QA use. See [TERMS.md](TERMS.md), [PRIVACY.md](PRIVACY.md), [LICENSE](LICENSE), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Do not upload the `.pem` signing key, CRX packages, local config, staff whitelist, or staff-key inventories.

## Reporting issues

Please report reproducible bugs through the repository's private issue tracker or contact the repository owner directly. Never include API keys, staff keys, student information, or unredacted page captures in a report.
