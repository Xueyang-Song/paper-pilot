# Evidence-Grounded Research Chat

Paper Pilot provides multiple named, linear research chats inside each project. New chats start in **Grounded** mode.

## Modes

- **Grounded** uses trusted project material only: paper metadata and abstracts, PDFs, imported or converted documents, and source tables. It requires each substantive research block to cite retrieved evidence. If no evidence is available, it says so instead of substituting model knowledge.
- **Exploratory** may use broader model knowledge. The composer, answer, export, and generated artifact retain an explicit warning. Project citations remain inspectable when used.

AI-generated briefs, chat answers, scripts, and crawl logs are not automatic grounding sources. Generated chat answers are deliberately not indexed, including when a user requests reindexing.

## Source pins and citations

Without pins, Paper Pilot searches the trusted project corpus. Add paper or artifact pins to constrain a single request; pins clear after sending. Each `S1`, `S2`, and similar marker opens the evidence excerpt, locator, and source navigation.

Citation validation proves that a marker refers to evidence retrieved for that run and that answer blocks visibly cite it. It does not prove semantic entailment or scientific correctness; inspect the excerpt and original source before relying on a claim.

## Runs, history, and outputs

Responses stream and can be stopped. The run trace reports safe operational events—context selection, retrieval, provider/model, app tools, approvals, citation validation, and artifact saving—without exposing hidden reasoning or secrets.

Paper Pilot sends the newest complete turns that fit the selected provider's context budget. Older messages remain visible and the trace reports how many were omitted; there is no hidden rolling summary.

Every successful final response creates one Markdown artifact under **Generated answers** with provider, model, mode, source scope, and a Sources appendix. Stopped, failed, or citation-invalid responses do not create answer artifacts.

## Provider privacy

Ollama runs locally. Vercel AI Gateway and OpenAI-compatible providers receive the selected recent chat context and retrieved evidence for the current request. Credentials remain in Electron secure storage and are never included in traces, messages, or exports.
