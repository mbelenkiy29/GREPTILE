import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {registerP4Checkout,verifyP4Checkout,p4CheckoutKey,type P4Read} from '../src/bridge-p4';

test('P4 bridge verifies native client, have revisions and pinned bytes without touching dirty work',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'openreview-p4-bridge-'))),file=path.join(root,'price.ts'),outside=await mkdtemp(path.join(tmpdir(),'openreview-p4-outside-'));
 const source=Buffer.from('export const cents = 199;\n'),depotFile='//depot/main/price.ts',calls:string[][]=[];
 let serverId='acceptance',owner='author',haveRevision='1',clientFile=file,lineEnd='unix',wrongPinned=false;
 const read:P4Read=async(args,options)=>{
  calls.push(args);assert.equal(options.cwd,root);assert.deepEqual(args.slice(0,4),['-p','ssl:p4.example:1666','-c','native-client']);
  const command=['info','client','fstat','print'].find(cmd=>args.includes(cmd));
  if(command==='info')return Buffer.from(JSON.stringify({ServerID:serverId,userName:'author',clientName:'native-client'})+'\n');
  if(command==='client')return Buffer.from(JSON.stringify({Client:'native-client',Root:root,Owner:owner,LineEnd:lineEnd,Options:'noallwrite noclobber'})+'\n');
  if(command==='fstat')return Buffer.from(JSON.stringify({depotFile,clientFile,haveRev:haveRevision})+'\n');
  if(command==='print'){assert.deepEqual(args.slice(args.indexOf('print')),['print','-q','-K',depotFile+'@=12']);return wrongPinned?Buffer.from('altered'):source;}
  throw new Error('Unexpected native command '+command);
 };
 try{
  await writeFile(file,source);await writeFile(path.join(root,'unrelated-dirty.txt'),'preserve me');
  const registered=await registerP4Checkout({root,server:'ssl:p4.example:1666',client:'native-client'},read);
  const manifest=[{depotFile,haveRevision:1,revision:'@=12',digest:createHash('md5').update(source).digest('hex'),fileSize:source.length}];
  assert.equal(await verifyP4Checkout(registered,manifest,read),root);
  assert.ok(calls.every(a=>['info','client','fstat','print'].some(cmd=>a.includes(cmd))));
  await writeFile(file,'existing changes');await assert.rejects(verifyP4Checkout(registered,manifest,read),/preserve the changes/);await writeFile(file,source);
  serverId='another';await assert.rejects(verifyP4Checkout(registered,manifest,read),/identity changed/);serverId='acceptance';
  owner='other';await assert.rejects(verifyP4Checkout(registered,manifest,read),/owner or identity mismatch/);owner='author';
  haveRevision='2';await assert.rejects(verifyP4Checkout(registered,manifest,read),/have revision/);haveRevision='1';
  wrongPinned=true;await assert.rejects(verifyP4Checkout(registered,manifest,read),/pinned file identity/);wrongPinned=false;
  lineEnd='win';await assert.rejects(verifyP4Checkout(registered,manifest,read),/unix-line-ending/);lineEnd='unix';
  await writeFile(path.join(outside,'secret.ts'),source);clientFile=path.join(outside,'secret.ts');await assert.rejects(verifyP4Checkout(registered,manifest,read),/outside/);
  await symlink(clientFile,path.join(root,'escape'));clientFile=path.join(root,'escape');await assert.rejects(verifyP4Checkout(registered,manifest,read),/outside/);clientFile=file;
  await assert.rejects(verifyP4Checkout(registered,[...manifest,...manifest],read),/duplicated/);
  for(const name of ['//depot/../secret','//depot/main/...','//depot/main/a#1','//depot/main/a@=12'])await assert.rejects(verifyP4Checkout(registered,[{...manifest[0],depotFile:name}],read));
  const executable=path.join(root,'p4'),tickets=path.join(root,'tickets'),trust=path.join(root,'trust');
  await Promise.all([writeFile(executable,'fixture CLI'),writeFile(tickets,'private fixture ticket'),writeFile(trust,'trusted fixture fingerprint')]);
  const configured=await registerP4Checkout({root,server:'ssl:p4.example:1666',client:'native-client',username:'author',p4Executable:executable,ticketsFile:tickets,trustFile:trust},async(args,options)=>{assert.equal(options.executable,executable);assert.equal(options.env?.P4TICKETS,tickets);assert.equal(options.env?.P4TRUST,trust);assert.equal(options.env?.P4CONFIG,'');assert.equal(options.env?.P4PASSWD,undefined);assert.ok(args.includes('-u'));return read(args,options);});
  assert.equal(configured.username,'author');assert.equal(configured.p4Executable,executable);
  await assert.rejects(registerP4Checkout({root,server:'ssl:p4.example:1666',client:'native-client',p4Executable:'relative/path'},read));
  assert.equal(p4CheckoutKey('https://review.example.com','native-project'),'p4:https://review.example.com:native-project');
  for(const origin of ['http://review.example.com','https://user:pass@review.example.com','https://review.example.com/path','https://review.example.com?ticket=secret'])assert.throws(()=>p4CheckoutKey(origin,'native-project'));
 }finally{await Promise.all([rm(root,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]);}
});

test('P4 added and deleted targets require exact archived actions, opened state and source identity',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'openreview-p4-actions-'))),added=path.join(root,'added.ts'),deleted=path.join(root,'empty','deleted.ts');
 const addSource='export const added = 199;\n',oldSource='export const removed = 199;\n',addDepot='//depot/main/added.ts',deleteDepot='//depot/main/deleted.ts';
 let wrongArchive=false,wrongAction=false,wrongHave=false,describes=0,move=false,wrongMovedSource=false,wrongMovedRevision=false;
 const read:P4Read=async args=>{
  if(args.includes('info'))return Buffer.from(JSON.stringify({ServerID:'native',userName:'author',clientName:'native-actions-client'})+'\n');
  if(args.includes('client'))return Buffer.from(JSON.stringify({Client:'native-actions-client',Root:root,Owner:'author',LineEnd:'unix',Options:'noallwrite'})+'\n');
  if(args.includes('describe')){describes++;return Buffer.from(JSON.stringify({change:wrongArchive?'15':'14',depotFile0:addDepot,action0:wrongAction?'edit':move?'move/add':'add',depotFile1:deleteDepot,action1:move?'move/delete':'delete'})+'\n');}
  if(args.includes('fstat'))return Buffer.from(JSON.stringify(args.at(-1)===addDepot?{depotFile:addDepot,clientFile:added,action:move?'move/add':'add',...(move?{haveRev:'1',movedFile:wrongMovedSource?'//depot/outside.ts':deleteDepot,movedRev:wrongMovedRevision?'2':'1'}:wrongHave?{haveRev:'1'}:{})}:{depotFile:deleteDepot,clientFile:deleted,action:move?'move/delete':'delete',haveRev:'1'})+'\n');
  if(args.includes('print')){assert.ok(args.at(-1)===addDepot+'@=14'||args.at(-1)===deleteDepot+'#1');return Buffer.from(args.at(-1)===addDepot+'@=14'?addSource:oldSource);}
  throw new Error('Unexpected mutation or native read');
 };
 const digest=(s:string)=>createHash('md5').update(s).digest('hex');
 const manifest=[{depotFile:addDepot,haveRevision:0,revision:'@=14',digest:digest(addSource),fileSize:Buffer.byteLength(addSource),nativeAction:'add' as const,archiveChange:14},{depotFile:deleteDepot,haveRevision:1,revision:'#1',digest:digest(oldSource),fileSize:Buffer.byteLength(oldSource),nativeAction:'delete' as const,archiveChange:14}];
 try{
  await writeFile(added,addSource);const checkout=await registerP4Checkout({root,server:'ssl:p4.example:1666',client:'native-actions-client'},read);
  assert.equal(await verifyP4Checkout(checkout,manifest,read),root);assert.equal(describes,1);
  wrongArchive=true;await assert.rejects(verifyP4Checkout(checkout,manifest,read),/changelist identity/);wrongArchive=false;
  wrongAction=true;await assert.rejects(verifyP4Checkout(checkout,manifest,read),/archived file action/);wrongAction=false;
  wrongHave=true;await assert.rejects(verifyP4Checkout(checkout,manifest,read),/have revision/);wrongHave=false;
  move=true;const movedManifest=[{...manifest[0],nativeAction:'move/add' as const},{...manifest[1],nativeAction:'move/delete' as const}];
  assert.equal(await verifyP4Checkout(checkout,movedManifest,read),root);
  wrongMovedSource=true;await assert.rejects(verifyP4Checkout(checkout,movedManifest,read),/moved source/);wrongMovedSource=false;
  wrongMovedRevision=true;await assert.rejects(verifyP4Checkout(checkout,movedManifest,read),/moved source/);wrongMovedRevision=false;
  await assert.rejects(verifyP4Checkout(checkout,[movedManifest[0]],read),/moved source/);move=false;
  const {mkdir}=await import('node:fs/promises');await mkdir(path.dirname(deleted));await writeFile(deleted,'existing work');await assert.rejects(verifyP4Checkout(checkout,manifest,read),/deleted target still exists/);await rm(deleted);
  await assert.rejects(verifyP4Checkout(checkout,[{...manifest[0],archiveChange:15}],read),/revisions disagree/);
  await assert.rejects(verifyP4Checkout(checkout,[{...manifest[0],nativeAction:undefined}],read),/revisions disagree/);
 }finally{await rm(root,{recursive:true,force:true});}
});
