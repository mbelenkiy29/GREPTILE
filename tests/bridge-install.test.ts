import { test } from "node:test";
import assert from "node:assert/strict";
import { installProtocol, type InstallEnvironment } from "../src/bridge-install";

function fakeOs(platform: string) {
  const writes: { file: string; mode?: number; content: string }[] = [], dirs: string[] = [], commands: { file: string; args: string[] }[] = [];
  const env: InstallEnvironment = {
    platform, userHome: "/home/dev",
    mkdir: (async (dir: string) => { dirs.push(String(dir)); return undefined; }) as InstallEnvironment["mkdir"],
    writeFile: (async (file: string, content: string, options?: { mode?: number }) => { writes.push({ file: String(file), content: String(content), mode: options?.mode }); }) as InstallEnvironment["writeFile"],
    chmod: (async () => undefined) as InstallEnvironment["chmod"],
    execute: async (file, args) => { commands.push({ file, args }); return { stdout: "" }; },
  };
  return { env, writes, dirs, commands };
}

test("Linux registers a private desktop entry for openreview:// with xdg-mime", async () => {
  const os = fakeOs("linux");
  await installProtocol("/home/dev/.config/openreview/bridge", "/opt/openreview/cli.mjs", "/usr/bin/node", os.env);
  assert.deepEqual(os.writes.map((w) => [w.file, w.mode]), [["/home/dev/.config/openreview/bridge/openreview-fix.desktop", 0o600], ["/home/dev/.local/share/applications/openreview-fix.desktop", 0o600]]);
  assert.match(os.writes[1].content, /^Exec="\/usr\/bin\/node" "\/opt\/openreview\/cli\.mjs" bridge dispatch --desktop %u$/m);
  assert.match(os.writes[1].content, /^MimeType=x-scheme-handler\/openreview;$/m);
  assert.deepEqual(os.commands, [{ file: "xdg-mime", args: ["default", "openreview-fix.desktop", "x-scheme-handler/openreview"] }]);
});

test("Windows registers the protocol per user and quotes paths for PowerShell", async () => {
  const os = fakeOs("win32");
  await installProtocol("C:/Users/O'Neil/openreview", "C:/Users/O'Neil/openreview/cli.mjs", "C:/Program Files/nodejs/node.exe", os.env);
  assert.equal(os.writes.length, 1);
  assert.match(os.writes[0].file, /openreview-fix\.ps1$/);
  assert.match(os.writes[0].content, /& 'C:\/Program Files\/nodejs\/node\.exe' 'C:\/Users\/O''Neil\/openreview\/cli\.mjs' bridge dispatch \$FixUrl/);
  assert.equal(os.commands.length, 1);
  const [{ file, args }] = os.commands;
  assert.equal(file, "powershell.exe");
  assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.match(args[2], /HKCU:\\Software\\Classes\\openreview/);
  assert.match(args[2], /'URL Protocol'/);
  assert.match(args[2], /-File "C:\/Users\/O''Neil\/openreview\/openreview-fix\.ps1" "%1"/, "single quotes in the path are doubled inside the registry command");
});

test("macOS builds and registers the URL handler app; unknown platforms fail before any OS change", async () => {
  const os = fakeOs("darwin");
  await installProtocol("/Users/dev/.config/openreview/bridge", "/opt/cli.mjs", "/usr/local/bin/node", os.env);
  assert.ok(os.writes.some((w) => w.file.endsWith("Info.plist") && w.content.includes("<string>openreview</string>")));
  assert.deepEqual(os.commands.map((c) => c.file.split("/").at(-1)), ["swiftc", "lsregister"]);
  const unknown = fakeOs("freebsd");
  await assert.rejects(installProtocol("/tmp/x", "/tmp/cli.mjs", "/usr/bin/node", unknown.env), /Unsupported desktop platform/);
  assert.deepEqual([unknown.dirs.length, unknown.writes.length, unknown.commands.length], [0, 0, 0]);
});
