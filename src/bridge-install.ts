import { writeFile, mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
const execute=promisify(execFile);
const sh=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function desktopExecArgument(value:string) {
 if(/[\u0000-\u001f\u007f]/.test(value))throw new Error("Desktop launcher paths must not contain control characters");
 // Desktop strings unescape before Exec quoting; literal percent signs must
 // also survive field-code expansion. JSON and shell quoting are insufficient.
 const quoted=value.replace(/[\\"$`]/g,c=>"\\"+c).replaceAll("\\","\\\\").replaceAll("%","%%");
 return '"'+quoted+'"';
}
export function protocolFiles(platform:string,home:string,cli:string,node:string) {
 if(platform==="linux"){
  if(node.includes("="))throw new Error("Desktop launcher executable path must not contain an equals sign");
  return {name:"openreview-fix.desktop",content:`[Desktop Entry]\nType=Application\nName=OpenReview Fix\nExec=${desktopExecArgument(node)} ${desktopExecArgument(cli)} bridge dispatch --desktop %u\nTerminal=true\nMimeType=x-scheme-handler/openreview;\nNoDisplay=true\n`};
 }
 if(platform==="win32")return {name:"openreview-fix.ps1",content:`param([string]$FixUrl)\n& ${"'"+node.replaceAll("'","''")+"'"} ${"'"+cli.replaceAll("'","''")+"'"} bridge dispatch $FixUrl\nRead-Host 'Press Enter to close'\n`};
 if(platform!=="darwin")throw new Error("Unsupported desktop platform");
 const script=`#!/bin/sh\nexec ${sh(node)} ${sh(cli)} bridge dispatch `;
 return {name:"OpenReviewFix.swift",content:`import Cocoa\nfinal class AppDelegate: NSObject, NSApplicationDelegate {\n func applicationWillFinishLaunching(_ notification: Notification) { NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(openURL(_:withReplyEvent:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL)) }\n @objc func openURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {\n  guard let raw = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue, let url = URLComponents(string: raw), url.scheme == "openreview", url.host == "fix", url.queryItems?.count == 1, let id = url.queryItems?.first, id.name == "request", let value = id.value, value.range(of: "^[a-z0-9]{16,64}$", options: .regularExpression) != nil else { NSApp.terminate(nil); return }\n  let file = URL(fileURLWithPath: ${JSON.stringify(home)}).appendingPathComponent("fix-" + value + ".command")\n  let command = ${JSON.stringify(script)} + "'openreview://fix?request=" + value + "'\\n"\n  do { try command.write(to: file, atomically: true, encoding: .utf8); try FileManager.default.setAttributes([.posixPermissions: 448], ofItemAtPath: file.path); let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-a", "Terminal", file.path]; try p.run() } catch { NSLog("OpenReview launch failed: %@", String(describing: error)) }\n  NSApp.terminate(nil)\n }\n}\nlet app = NSApplication.shared\nlet delegate = AppDelegate()\napp.delegate = delegate\napp.setActivationPolicy(.accessory)\napp.run()\n`};
}
export async function installProtocol(home:string,cli:string,node:string) {
 await mkdir(home,{recursive:true,mode:0o700});const file=protocolFiles(process.platform,home,cli,node);const source=path.join(home,file.name);await writeFile(source,file.content,{mode:0o600});
 if(process.platform==="linux") {const dir=path.join(homedir(),".local","share","applications");await mkdir(dir,{recursive:true});const target=path.join(dir,file.name);await writeFile(target,file.content,{mode:0o600});await execute("xdg-mime",["default",file.name,"x-scheme-handler/openreview"]);return;}
 if(process.platform==="win32") {const ps=`$root='HKCU:\\Software\\Classes\\openreview'; New-Item $root -Force | Out-Null; Set-Item $root 'URL:OpenReview Fix'; New-ItemProperty $root -Name 'URL Protocol' -Value '' -Force | Out-Null; New-Item "$root\\shell\\open\\command" -Force | Out-Null; Set-Item "$root\\shell\\open\\command" 'powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "${source.replaceAll("'","''")}" "%1"'`;await execute("powershell.exe",["-NoProfile","-Command",ps]);return;}
 const app=path.join(home,"OpenReview Fix.app");const contents=path.join(app,"Contents");await mkdir(path.join(contents,"MacOS"),{recursive:true});await writeFile(path.join(contents,"Info.plist"),`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.openreview.fix</string><key>CFBundleExecutable</key><string>OpenReviewFix</string><key>CFBundleName</key><string>OpenReview Fix</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>OpenReview</string><key>CFBundleURLSchemes</key><array><string>openreview</string></array></dict></array></dict></plist>`);
 const binary=path.join(contents,"MacOS","OpenReviewFix");await execute("swiftc",[source,"-o",binary],{timeout:120000});await chmod(binary,0o700);await execute("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",["-f",app]);
}
