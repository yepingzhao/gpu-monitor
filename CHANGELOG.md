# Changelog

## 0.1.3 — Local fork

- Keep the last successful GPU snapshot visible while polling in the background.
- Refresh only the affected server subtree instead of rebuilding the entire tree.
- Use stable server, GPU and process IDs to preserve expansion and selection.
- Apply refresh interval changes without clearing the server list.
- Include runtime dependencies in VSIX packages and compile before packaging.
- Add refresh regression tests and an F5 extension development configuration.
