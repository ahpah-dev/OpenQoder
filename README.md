# OpenQoder

A lightweight local chat workspace for an existing 9Router or OmniRoute installation. It discovers models from the router's live OpenAI-compatible catalog and sends conversations through the selected router. OpenQoder is an independent project, not an official Qoder product.

## Start

1. Install Python 3.9 or newer. No Python packages are required.
2. Start and configure [9Router](https://github.com/decolua/9router) or [OmniRoute](https://github.com/diegosouzapw/OmniRoute). Connect the providers you want to use in that router's dashboard. Both commonly expose `http://localhost:20128/v1`; use a different port if that is how your instance is configured.
3. Double-click **Start OpenQoder.cmd**, or run `python server.py --open` from this folder. Keep the terminal window open. The app opens at `http://127.0.0.1:8765`, or the next available port through 8795. The terminal shows the actual address. Close the terminal or press Ctrl+C to stop it.
4. In the app, enter your router's local base URL and its endpoint API key, connect, and select a model from the live list. Refresh the list after changing providers or models in your router.

To use another app port, run `python server.py --port 8766 --open`.

## Model availability and costs

The live catalog comes from your router and may include paid as well as free models. A catalog entry does not guarantee that a model is free, currently available, configured, or suitable for chat. Check the provider's terms, account, and quotas in your router before use. Specific model names, including DeepSeek, GLM, ERNIE, and Qwen variants, only appear if your installed router exposes them; OpenQoder does not manufacture model access or silently substitute models.

## Scope and privacy

OpenQoder is a chat client, not an autonomous coding agent: it does not run commands. In a supported Chromium browser such as Chrome or Edge, you can open a project folder, select a file (up to 200 KB) to include in your next message, and save the first fenced code block from a response to a file you choose. Attaching a file sends its contents to the configured router and provider. Folder access is requested again when needed.

The server binds to loopback and proxies only to local HTTP router addresses. The browser stores connection settings, including the router key, and chat data locally. Requests and conversation content pass to your selected router and onward to its configured provider. Router keys are sent to the local OpenQoder server and router. Review the router and provider privacy policies for their handling of your data.

If the catalog does not load, check that the router is running, that its API key and port are correct, and that at least one provider is connected. The two routers use the same default port, so run them on different ports if using both at once.

## License

OpenQoder is released under the [Unlicense](LICENSE).
