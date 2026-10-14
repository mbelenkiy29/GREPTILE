import { gzipSync } from "node:zlib";

/** A regular-file-only USTAR archive with a wrapper directory, matching Git provider archives. */
export function runtimeTar(files:{path:string;bytes:Uint8Array;executable:boolean}[]){
 const chunks:Buffer[]=[];const seen=new Set<string>();let total=0;
 for(const file of files){
  if(!file.path||/[\0\r\n\\]/.test(file.path)||file.path.split("/").some(p=>!p||p==="."||p==="..")||seen.has(file.path))throw new Error("Invalid or duplicate runtime archive path");
  seen.add(file.path);total+=file.bytes.length;if(total>20000000||files.length>10000)throw new Error("Runtime source exceeds 20 MB or 10,000 files");
  const full="source/"+file.path;let name=full,prefix="";
  if(Buffer.byteLength(name)>100){const split=full.lastIndexOf("/");name=full.slice(split+1);prefix=full.slice(0,split);}
  if(Buffer.byteLength(name)>100||Buffer.byteLength(prefix)>155)throw new Error("Runtime source path exceeds USTAR coverage");
  const header=Buffer.alloc(512),octal=(at:number,width:number,value:number)=>header.write(value.toString(8).padStart(width-1,"0")+"\0",at,width,"ascii");
  header.write(name,0,100);octal(100,8,file.executable?0o755:0o644);octal(108,8,0);octal(116,8,0);octal(124,12,file.bytes.length);octal(136,12,0);
  header.fill(32,148,156);header[156]=48;header.write("ustar\0",257,6,"ascii");header.write("00",263,2,"ascii");header.write(prefix,345,155);
  header.write([...header].reduce((sum,b)=>sum+b,0).toString(8).padStart(6,"0")+"\0 ",148,8,"ascii");
  chunks.push(header,Buffer.from(file.bytes),Buffer.alloc((512-file.bytes.length%512)%512));
 }
 chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks));
}

