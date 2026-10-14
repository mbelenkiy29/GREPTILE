# Native Linux bridge installation and unpaired recovery

October 4, 2026. The real bridge CLI is now installed from the current source in the isolated Ubuntu 26.04 aarch64 VM at `/opt/openreview-bridge-acceptance`. This is native Linux registration evidence; graphical launch and agent fixes remain separate acceptance requirements.

## Preparation and actual installation

Copied `src`, `bin` and `scripts/sandbox.ts`, without application environment files, credential files, checkouts or host mounts. A separate acceptance package pins tsx 4.23.15, zod 3.25.76, TypeScript 5.9.3, ignore 7.0.11 and picomatch 4.0.7, matching installed repository dependencies. Installation used the official npm registry with lifecycle scripts, audit and funding requests disabled. The runtime worker's separate package and service configuration were preserved.

Ubuntu's official configured apt repository supplied `xdg-utils` 1.2.1-2ubuntu2, without recommended packages or unrelated upgrades. `bridge --help` ran through the actual `bin/openreview.mjs` entry point. Before registration, the native `x-scheme-handler/openreview` query was empty.

The actual `openreview bridge install` command succeeded. `xdg-mime query default x-scheme-handler/openreview` now returns `openreview-fix.desktop`. Native GIO independently identifies that same default handler; its parsed executable exists at `/opt/node24/bin/node`, and its command points at the actual acceptance CLI followed by `bridge dispatch %u`. The installed entry retains Terminal=true. The bridge directory mode is 0700, desktop entry mode 0600. Repeating installation succeeded and retained the launcher digest `93503a7de0116109681e544ef53b6e78b79609910378e599629af1a57601ac8d`.

The first inspection treated GIO's quoted executable token as an unquoted filesystem path and incorrectly rejected it. Parsing the command's quoted token with native GLib before checking the path corrected this inspection; no launcher source change was needed. The earlier native reserved-character argument test remains independent evidence in [Linux quoting acceptance](linux-protocol-quoting-acceptance.md).

## Native missing-setup evidence and boundaries

The actual Linux `bridge status` returned exit 1, reported Codex/Claude/Cursor unavailable and supplied pairing instructions. There is no bridge config/credential file. No pairing request, Fix claim, checkout registration, coding-agent launch or inference occurred. The runtime worker remains disabled without its credential file. Host/guest bridge source digests match.

This Linux VM is headless and has no configured graphical display or default terminal emulator. Therefore registration does not establish browser-to-terminal dispatch, desktop confirmation UX or any Linux agent fix. A graphical Linux session/terminal, selected agent installation and authentication, approved pairing and registered exact-revision checkout are still needed. Those can be prepared in further work; they are not declared permanently unprovisionable. The VM is Mac-hosted acceptance infrastructure, not always-on cloud hosting or a Windows test environment.

No implementation changes or new regression run were required; the preceding 350 passing tests, lint, both typechecks and build remain source-release evidence. Only native Linux installation/setup checks ran here.

Artifacts: `output/setup/linux-bridge-{dependencies,xdg-install,help,mime-before,install,registration,unpaired-status,install-repeat,credential-boundary,environment}.log`, `linux-bridge-native-receipt.json`, `linux-bridge-host-source-digests.log`, `linux-bridge-inspect.py`, and `linux-bridge-package/package.json`. Full acceptance and Greptile parity remain unproven.
