import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { Readable } from "node:stream";
import { runtimeRevisionSchema } from "../src/runtime-revision";

export function sandboxArguments(
  name: string,
  image: string,
  command: string,
  seconds: number,
  stripComponents = 0,
  executionMarker?:string,
): string[] {
  if (!/^[-a-zA-Z0-9_./:]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Use an explicitly trusted image pinned by sha256 digest");
  if (
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 600 ||
    !command.trim() ||
    command.length > 2000
    || ![0,1].includes(stripComponents)
    || (executionMarker!==undefined&&!/^[a-f0-9-]{36}$/.test(executionMarker))
  )
    throw new Error("Invalid runtime limits or command");
  return [
    "run",
    "--rm",
    "--name",
    name,
    "-i",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--user",
    "65534:65534",
    "--tmpfs",
    "/work:rw,nosuid,nodev,size=256m,mode=1777",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--workdir",
    "/work",
    image,
    "sh",
    "-c",
    `tar -${stripComponents ? "xzf" : "xf"} - -C /work${stripComponents ? " --strip-components=1" : ""} && timeout ${seconds}s sh -c ${executionMarker?`'printf "OPENREVIEW_RUNTIME_STARTED:%s\\n" "$2"; exec sh -c "$1"' openreview "$1" "$2"`:'"$1"'}`,
    "openreview",
    command,
    ...(executionMarker?[executionMarker]:[]),
  ];
}
export async function validateRuntime(
  image: string,
  command: string,
  seconds: number,
) {
  const headSha = (
    await promisify(execFile)("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  const archive = spawn("git", ["archive", "--format=tar", headSha], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const archived = new Promise<number|null>((resolve,reject)=>{archive.once("close",resolve);archive.once("error",reject);});
  archive.stderr.resume();
  try{
    const [result,archiveExit]=await Promise.all([validateRuntimeArchive(image,command,seconds,headSha,archive.stdout,0),archived]);
    if(archiveExit!==0)throw new Error("Could not archive the exact Git revision");
    return result;
  }finally{archive.kill();}
}
export async function validateRuntimeArchive(image:string,command:string,seconds:number,headSha:string,archive:Readable,stripComponents=1,signal?:AbortSignal){
  signal?.throwIfAborted();
  runtimeRevisionSchema.parse(headSha);
  const name="openreview-validation-"+randomUUID();
  const marker=randomUUID(),args=sandboxArguments(name,image,command,seconds,stripComponents,marker);
  const docker = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const cancel=()=>{archive.destroy();docker.kill("SIGKILL");};
  signal?.addEventListener("abort",cancel,{once:true});
  const output: string[] = [];
  let bytes = 0;
  let timedOut = false;
  const consume = (data: Buffer) => {
    bytes += data.length;
    if (bytes <= 1000000) output.push(data.toString());
    else {
      timedOut = true;
      docker.kill("SIGKILL");
    }
  };
  docker.stdout.on("data", consume);
  docker.stderr.on("data", consume);
  archive.pipe(docker.stdin);
  docker.stdin.on("error", () => {
    archive.destroy();
  });
  const timer = setTimeout(
    () => {
      timedOut = true;
      docker.kill("SIGKILL");
    },
    (seconds + 30) * 1000,
  );
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      docker.once("close", resolve);
      docker.once("error", reject);
      archive.once("error", reject);
    });
    signal?.throwIfAborted();
    const captured=output.join(""),started="OPENREVIEW_RUNTIME_STARTED:"+marker+"\n";
    return {
      headSha,
      image,
      command,
      exitCode,
      timedOut:timedOut||exitCode===124,
      executionStarted:captured.includes(started),
      output: captured.replaceAll(started,"").slice(-20000),
      outputTruncated: bytes > 20000,
      network: "none",
      memoryMb: 512,
      cpus: 1,
    };
  } finally {
    signal?.removeEventListener("abort",cancel);
    clearTimeout(timer);
    archive.destroy();
    await promisify(execFile)("docker", ["rm", "-f", name]).catch(
      () => undefined,
    );
  }
}
if (process.argv[1]?.endsWith("sandbox.ts")) {
  const { values } = parseArgs({
    options: {
      image: { type: "string" },
      command: { type: "string" },
      timeout: { type: "string", default: "120" },
    },
  });
  validateRuntime(
    values.image ?? "",
    values.command ?? "",
    Number(values.timeout),
  )
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.exitCode !== 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
