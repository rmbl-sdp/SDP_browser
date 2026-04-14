# Git hooks

`pre-commit` is a Python 3 script that blocks the commit when staged changes:

- exceed **10 MB** per file,
- include a **sensitive filename** (`.env*`, `*.pem`, `id_rsa`, `credentials*`, `service-account*.json`, …), or
- contain a **well-known secret pattern** in added lines (AWS keys, GitHub tokens, private-key headers, Slack/Google API keys, quoted credential assignments).

## Enable (one-time, per clone)

```bash
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
```

Verify:

```bash
git config --get core.hooksPath   # → .githooks
```

## Bypass (don't)

If you're absolutely sure a match is a false positive:

```bash
git commit --no-verify
```

If you find yourself doing that, update the patterns instead.
