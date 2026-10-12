# Security

SketchUp Factory runs AI agents with shell access on the machine that hosts it. Read the
[Security model](README.md#security-model) and [Known gaps](README.md#known-gaps) sections of the
README before exposing it beyond your own network.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository, not in a
public issue. Include what an attacker needs (network access, a login, an API key, text an agent
reads) and what they gain. There is no bug bounty.

Things that are known and documented rather than vulnerabilities: an agent in `bypassPermissions`
can do anything its OS user can (the guard is a seatbelt, not a sandbox), and an agent that reads
untrusted text can be steered by it.

## Keeping your install safe

- Keep `config.json` and `data/` private; both are gitignored. They hold tokens, password hashes,
  API key hashes, VAPID keys and transcripts.
- Use long passwords (`node server/user.ts`), and revoke API keys you no longer use
  (`node server/apikey.ts --revoke <name>`).
- Prefer a private network (Tailscale) over a public URL; if you publish it, the login page is on
  the internet.
- List every checkout agents must never touch in `protectedPaths`.
- This app's own checkout is protected too, unless you set `guard.protectFactoryCheckout` to `false`
  (also settable with `set_app_config`). Turn it off only on an install you own outright, where you
  want agents to update and change the app in place: they can then run any command and edit any file
  in its code, including the guard itself, so the seatbelt there is only as good as the agent. `data/`
  stays protected either way, by absolute or relative name (`cd <checkout> && cat data/…`) and against
  `git clean -x` in the checkout; a script file or a glob can still reach it, as with every guard rule.
