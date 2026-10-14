import type {P4Snapshot} from './perforce';
import type {parseP4SubmittedInventory} from './p4-index';
import {p4FixFileSchema,type P4FixFile} from './bridge-p4';

export function p4FixManifest(inventory:ReturnType<typeof parseP4SubmittedInventory>,indexedFiles:{path:string;sha:string}[],snapshot:P4Snapshot){
 const files:P4FixFile[]=indexedFiles.map(indexed=>{
  const baseline=inventory.manifest.find(f=>f.depotFile.slice(2)===indexed.path);
  if(!baseline?.digest||baseline.fileSize===undefined||indexed.sha!==`p4:${inventory.serverId}:${baseline.headRev}:${baseline.digest.toLowerCase()}`)throw new Error('P4 indexed fix source identity mismatch');
  const changed=snapshot.files.find(f=>f.depotFile===baseline.depotFile),deleted=changed&&(changed.action==='delete'||changed.action==='move/delete');
  return p4FixFileSchema.parse({depotFile:baseline.depotFile,haveRevision:baseline.headRev,revision:changed&&!deleted?'@='+snapshot.change:'#'+baseline.headRev,digest:changed&&!deleted?changed.digest:baseline.digest,fileSize:changed&&!deleted?changed.fileSize:baseline.fileSize,...(changed?{nativeAction:changed.action,archiveChange:snapshot.change}:{})});
 });
 for(const changed of snapshot.files){
  if(!['text','utf8','unicode'].includes(changed.type.split('+')[0]))throw new Error('P4 fix changed source type exceeds readable coverage');
  if(files.some(f=>f.depotFile===changed.depotFile))continue;
  if(!['add','branch','move/add'].includes(changed.action)||inventory.manifest.some(f=>f.depotFile===changed.depotFile))throw new Error('P4 changed source is outside the readable baseline');
  files.push(p4FixFileSchema.parse({depotFile:changed.depotFile,haveRevision:0,revision:'@='+snapshot.change,digest:changed.digest,fileSize:changed.fileSize,nativeAction:changed.action,archiveChange:snapshot.change}));
 }
 if(!files.length||files.length>1000||new Set(files.map(f=>f.depotFile)).size!==files.length||files.reduce((n,f)=>n+f.fileSize,0)>20000000)throw new Error('P4 fix source manifest exceeds supported coverage');
 return files;
}
