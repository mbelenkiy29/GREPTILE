import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {p4SubmittedInventory} from '../src/p4-index';
import {p4FixManifest} from '../src/p4-fix-manifest';
import type {P4Snapshot} from '../src/perforce';

test('native fix manifests retain deleted baseline identity and pin additions without accepting unindexed edits',()=>{
 const digest=createHash('md5').update('export const cents=199;\n').digest('hex'),old='//depot/main/old.ts',added='//depot/main/added.ts';
 const inventory=p4SubmittedInventory({serverId:'native',change:5,project:{id:'payments',name:'Payments',deleted:false,branches:[{id:'main',name:'Main',paths:['//depot/main/...']}]},manifest:[{code:'stat',depotFile:old,headRev:1,headChange:5,headAction:'add',headType:'text',digest,fileSize:23}]});
 const indexed=[{path:old.slice(2),sha:'p4:native:1:'+digest}];
 const snapshot:P4Snapshot={projectId:'payments',revision:'p4:14:1:15:'+'a'.repeat(64),version:1,change:15,coverage:[],review:{id:14,author:'author',description:'Native actions',updated:1,pending:true,state:'needsReview',projects:{payments:['main']},versions:[{change:14,archiveChange:15,pending:true,time:1}]},files:[{depotFile:old,action:'delete',type:'text',rev:1},{depotFile:added,action:'add',type:'text',rev:1,digest,fileSize:23}]};
 const result=p4FixManifest(inventory,indexed,snapshot);
 const moved=p4FixManifest(inventory,indexed,{...snapshot,files:snapshot.files.map(f=>({...f,action:f.action==='delete'?'move/delete':'move/add'}))});
 assert.deepEqual(moved.map(f=>[f.nativeAction,f.haveRevision,f.revision]),[['move/delete',1,'#1'],['move/add',0,'@=15']]);
 assert.equal(result.length,2);assert.deepEqual(result[0],{depotFile:old,haveRevision:1,revision:'#1',digest,fileSize:23,nativeAction:'delete',archiveChange:15});assert.deepEqual(result[1],{depotFile:added,haveRevision:0,revision:'@=15',digest,fileSize:23,nativeAction:'add',archiveChange:15});
 assert.throws(()=>p4FixManifest(inventory,[{...indexed[0],sha:'altered'}],snapshot),/indexed fix source/);
 assert.throws(()=>p4FixManifest(inventory,[...indexed,...indexed],snapshot),/coverage/);
 assert.throws(()=>p4FixManifest(inventory,[],snapshot),/readable baseline/);
 assert.throws(()=>p4FixManifest(inventory,indexed,{...snapshot,files:[snapshot.files[0],{...snapshot.files[1],action:'edit'}]}),/readable baseline/);
 assert.throws(()=>p4FixManifest(inventory,indexed,{...snapshot,files:[snapshot.files[0],{...snapshot.files[1],type:'binary'}]}),/readable coverage/);
});
