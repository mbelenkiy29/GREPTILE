import test from "node:test";
import assert from "node:assert/strict";
import {connectWorkspace,linkPersonalIdentity} from "../forge/bitbucket/static/connection.js";

test("native settings require an explicit valid single-use code and report suspension and remote failure truthfully",async()=>{
 let calls=0;
 const invoke=async(value:unknown)=>{calls++;assert.deepEqual(value,{path:"/api/bitbucket/forge/connect",method:"POST",headers:{"content-type":"application/json"},body:{code:"a".repeat(64)}});return {status:200,body:{connectionId:"native-fixture",status:"suspended"}};};
 for(const code of ["", "a".repeat(63),"g".repeat(64),"a".repeat(65)])await assert.rejects(connectWorkspace(invoke,code),/64-character/);assert.equal(calls,0);
 assert.deepEqual(await connectWorkspace(invoke,"a".repeat(64)),{connectionId:"native-fixture",status:"suspended"});assert.equal(calls,1);
 for(const response of [{status:403,body:{error:"denied"}},{status:200,body:{}},{status:200,body:{connectionId:"native-fixture",status:"ready"}}])await assert.rejects(connectWorkspace(async()=>response,"a".repeat(64)),/Connection failed/);
 await assert.rejects(connectWorkspace(async()=>{throw new Error("offline");},"a".repeat(64)),/offline/);
});

test("native personal confirmation uses its distinct route and requires an explicit code and truthful expiry",async()=>{
 let calls=0;const expiresAt=Date.now()+60000,invoke=async(value:unknown)=>{calls++;assert.deepEqual(value,{path:"/api/bitbucket/forge/identity",method:"POST",headers:{"content-type":"application/json"},body:{code:"b".repeat(64)}});return {status:200,body:{status:"linked",expiresAt}};};
 for(const code of ["","b".repeat(63),"z".repeat(64)])await assert.rejects(linkPersonalIdentity(invoke,code));assert.equal(calls,0);assert.deepEqual(await linkPersonalIdentity(invoke,"b".repeat(64)),{status:"linked",expiresAt});assert.equal(calls,1);
 for(const result of [{status:403,body:{}},{status:200,body:{status:"linked"}},{status:200,body:{status:"connected",expiresAt}}])await assert.rejects(linkPersonalIdentity(async()=>result,"b".repeat(64)));
});
