import {build} from "esbuild";
import {mkdir,copyFile} from "node:fs/promises";
await mkdir(new URL("./static/build/",import.meta.url),{recursive:true});
await copyFile(new URL("./static/index.html",import.meta.url),new URL("./static/build/index.html",import.meta.url));
await copyFile(new URL("./static/styles.css",import.meta.url),new URL("./static/build/styles.css",import.meta.url));
await build({entryPoints:[new URL("./static/index.js",import.meta.url).pathname],outfile:new URL("./static/build/index.js",import.meta.url).pathname,bundle:true,format:"iife",platform:"browser",target:"es2022",minify:true});

await mkdir(new URL("./static/build/personal/",import.meta.url),{recursive:true});
await copyFile(new URL("./static/personal.html",import.meta.url),new URL("./static/build/personal/index.html",import.meta.url));
await copyFile(new URL("./static/styles.css",import.meta.url),new URL("./static/build/personal/styles.css",import.meta.url));
await copyFile(new URL("./static/build/index.js",import.meta.url),new URL("./static/build/personal/index.js",import.meta.url));
