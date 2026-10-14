import test from "node:test";
import assert from "node:assert/strict";
import {boundRequirementsContext} from "../src/requirements-context";
import {citesFetchedRequirements} from "../src/engine/review";
import type {SourceFile} from "../src/engine/types";

test("mixed issue providers share one UTF-8 context budget and cannot cite omitted documents",()=>{
 const file=(provider:string,content:string):SourceFile=>({path:`requirements/${provider}/document.md`,sha:"native-version",content,provenance:{repository:provider,revision:"native-version",sourceUrl:provider==="linear"?"https://linear.app/team/issue/ENG-1/example":`https://fixture.atlassian.net/${provider}/document`}});
 const linear=file("linear","é".repeat(30000)),atlassian=file("atlassian","a".repeat(60000)),small=file("confluence","a".repeat(40000));
 const bounded=boundRequirementsContext([linear,atlassian,small]);
 assert.deepEqual(bounded.files,[linear,small]);assert.equal(bounded.files.reduce((n,f)=>n+Buffer.byteLength(f.content,"utf8"),0),100000);assert.match(bounded.coverage.join(),/1 fetched documents were omitted/);
 assert.equal(bounded.files[0].provenance,linear.provenance);
 const urls=bounded.files.map(f=>f.provenance!.sourceUrl!);
 assert.equal(citesFetchedRequirements(atlassian.provenance!.sourceUrl!,urls),false);assert.equal(citesFetchedRequirements(linear.provenance!.sourceUrl!,urls),true);
 assert.deepEqual(boundRequirementsContext([small]).coverage,[]);assert.deepEqual(boundRequirementsContext([]).files,[]);
});
