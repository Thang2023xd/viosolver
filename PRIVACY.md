# Privacy notice

This notice describes the VioEdu QA Assistant Chrome extension.

## Data handled by the extension

- Exercise question text, answer options, and page structure needed to identify the current exercise.
- API credentials entered by the user for OpenRouter or Groq.
- Staff key and temporary authentication expiry, stored locally by the extension.

The extension stores configuration and credentials in Chrome extension local storage on the user's browser profile. It does not intentionally send API credentials to VioEdu. When solving is requested, it sends the prompt and answer choices to the selected AI provider. The provider processes that data under its own terms and privacy policy. VioEdu page requests may also be observed locally by the extension's QA interceptor to identify question data.

## User choices and retention

Users can change providers or clear saved credentials in extension settings. Clearing extension data or removing the extension deletes locally stored extension settings. Provider-side retention is governed by that provider and cannot be controlled by this extension.

## Data minimization

Do not use the extension on personal or confidential data unless you have authorization to share it with the selected AI provider. Redact credentials and personal information from screenshots and bug reports.

## Contact

Contact the repository owner through the private repository or the channel used to provide access.
