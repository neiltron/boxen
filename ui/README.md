# Session UI

## Workspace controls

- **Ctrl+Alt+J / Ctrl+Alt+K** (Cmd instead of Ctrl on macOS): next / previous
  visible panel. From the session list or elsewhere outside the selected
  session's workspace, either shortcut first enters the chat composer.
  With the default two-panel layout, subsequent presses alternate chat and
  the right-hand panel. This changes keyboard focus, not the selected session.
- **F6 / Shift+F6**: next / previous panel while focus is inside the workspace,
  including the composer. Outside it, F6 retains its browser behavior.
- **Ctrl+Alt+] / Ctrl+Alt+[** (Cmd on macOS): Trellis's next / previous tab.
- The panel toggle hides/restores whole tab groups, retaining docking,
  tab order, selection and proportions. Hidden groups aren't cycled into.

Global panel shortcuts are inactive when no session is selected and do not
escape dialogs or handle IME/AltGr input. Embedded Preview/artifact iframes
have their own keyboard context: click outside the iframe to use the shortcuts.

Layout version 2 resets saved desktop/mobile arrangements once to clear the
floating panels created by the old per-tab hide loop. Phones still start with
the panel hidden below chat, using a separate layout from desktop.

## Checks

```sh
npm ci
npx playwright install --with-deps chromium  # first run on a supported host
npm run test:workspace
node events.check.ts
npm run build
npm run lint
```

The Playwright suite uses a real Trellis workspace in an isolated Vite fixture;
no cell backend is required. It covers entering from the session list, cycling
and composer focus, macOS key codes, nested hide/restore, horizontal/vertical
layouts, partial hiding, dialogs/IME, and listener teardown/rebinding.

## React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
