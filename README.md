# Self Context Manager

Context management layer for LLM agents. Controls what is kept, retrieved, and surfaced in the active context window over time.

## Status

- Active storage/runtime path is SQLite-based.
- Storage is implemented behind `StoragePort` with DB conformance coverage under `tests/storage/`.
- Active runtime is `SelfContextManager` in `src/phase3-extension.ts`.
- Current Pi wrapper is `.pi/live-drive/scm-live-drive.ts`.

## Documentation model

- `docs/intent-ssot-v1.md` is the canonical external intent doc.
- Implementation documentation now lives in source docstrings, not long-form markdown specs.
- Generated implementation reference: `docs/generated/implementation-reference.md`
- Docs index and authority map: `docs/README.md`

Implementation docstring authority currently lives in:
- `src/storage/storage-port.ts`
- `src/storage/sqlite-schema.ts`
- `src/storage/sqlite-storage.ts`
- `src/phase3-extension.ts`
- `.pi/live-drive/scm-live-drive.ts`

## Docs commands

```bash
npm run docs:generate
npm run docs:check
```

## Active source layout

```text
src/                        # Active TypeScript source (runtime + sqlite storage)
.pi/live-drive/             # Current Pi wrapper used for live-drive integration
scripts/                    # Utility scripts, including implementation doc generation
tests/                      # Active tests (vitest; storage + agentic + phase/e2e)
docs/                       # Intent doc, generated docs, archive, and doc index
```

## Removal note

- Legacy external-backend client, scripts, and integration tests were removed.
- Historical archive docs may still reference the removed backend; treat those as non-normative history.

## License

MIT
