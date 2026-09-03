# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript/React Vencord plugin. `index.tsx` registers the plugin and mounts the sidebar; `settings.tsx`, `types.ts`, and `declarations.d.ts` provide shared configuration and typings. Keep UI code in `components/`, Discord store/API integrations in `discord/`, model-provider and agent logic in `llm/`, and IndexedDB persistence in `storage/`. Tests live in `test/`, with Vencord aliases supplied by `test/mocks/vencord.ts`. Read `context.md` before changing architecture or scope rules.

## Build, Test, and Development Commands

- `npm install` installs the local dependencies.
- `npm run typecheck` runs strict TypeScript checking through `tsconfig.dev.json` without emitting files.
- `npm run build` currently performs the same no-emit compilation check.
- `npm test` runs `test/scope.test.ts` followed by `test/search.test.ts` with `tsx`.
- `npm run sync` copies the plugin into the maintainer's local Vencord checkout. `build:vencord` and `inject` also depend on the machine-specific `/Users/raymond/Documents/Vencord` path; adjust these scripts locally before using them elsewhere.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, single-quoted imports/strings, and trailing commas in multiline objects and argument lists. Name React components and exported types with PascalCase (`ScopeIndicator`), functions and variables with camelCase (`getCurrentScopeContext`), and test files `*.test.ts`. Keep imports grouped at the top and prefer explicit shared types from `types.ts`. No formatter or linter is configured, so match adjacent code and rely on typechecking.

## Testing Guidelines

Tests are executable TypeScript scripts using `console.assert`, not a separate test framework. Add focused assertions to the closest existing suite or create another `test/<feature>.test.ts` file and include it in the `test` script. Run `npm test` and `npm run typecheck` before submitting. There is no coverage threshold; prioritize search edge cases, Discord data-shape variations, and scope/privacy failures.

## Commit & Pull Request Guidelines

Recent history favors concise Conventional Commit subjects such as `feat: ...`, `fix(ui): ...`, and `docs: ...`; use an imperative, scoped summary when practical. Pull requests should explain user-visible behavior, list validation commands, link relevant issues, and include screenshots or recordings for sidebar/settings changes. Highlight changes to Discord API access, provider requests, or persistence.

## Security & Configuration

Never commit API keys, Discord tokens, message content, or local endpoint credentials. Preserve the access checks in `discord/scope.ts`: guild searches must remain permission-limited, and DM searches must not escape the active DM or mutual group-DM boundary.
