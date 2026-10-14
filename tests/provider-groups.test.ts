import test from "node:test";
import assert from "node:assert/strict";
import {Github} from "../src/github";
import {Gitea} from "../src/gitea";
import {Gitlab} from "../src/gitlab";
import {BitbucketDC} from "../src/bitbucket-dc";
test("native discovery retains stable organization/group/project identities and excludes personal namespaces",async t=>{
 t.mock.method(globalThis,"fetch",async(input:string)=>{
  const url=new URL(String(input));let body;
  if(url.hostname==="api.github.com")body={repositories:[{id:1,full_name:"Acme/repo",name:"repo",default_branch:"main",private:true,owner:{login:"Acme",id:61,type:"Organization"}}]};
  else if(url.hostname==="gitea.example")body=[{id:1,full_name:"Acme/repo",default_branch:"main",clone_url:"https://gitea.example/Acme/repo.git",owner:{id:61,login:"Acme",type:"Organization"}},{id:2,full_name:"alice/repo",default_branch:"main",clone_url:"https://gitea.example/alice/repo.git",owner:{id:62,login:"alice",type:"User"}}];
  else if(url.hostname==="gitlab.example")body=[{id:1,path_with_namespace:"Acme/nested/repo",default_branch:"main",http_url_to_repo:"https://gitlab.example/Acme/nested/repo.git",namespace:{id:61,kind:"group",full_path:"Acme/nested"}},{id:2,path_with_namespace:"alice/repo",default_branch:"main",http_url_to_repo:"https://gitlab.example/alice/repo.git",namespace:{id:62,kind:"user",full_path:"alice"}}];
  else if(url.pathname.endsWith("/default-branch"))body={displayId:"main"};
  else body={values:[{id:1,slug:"repo",project:{id:61,key:"ACME",name:"Acme",type:"NORMAL"},scmId:"git",links:{clone:[{name:"http",href:"https://bitbucket.example/scm/ACME/repo.git"}]}},{id:2,slug:"repo",project:{id:62,key:"~alice",type:"PERSONAL"},scmId:"git",links:{clone:[{name:"http",href:"https://bitbucket.example/scm/~alice/repo.git"}]}}],isLastPage:true};
  return Response.json(body);
 });
 const [github]=await new Github("fixture").repositories();assert.equal(github.owner.id,61);assert.equal(github.owner.type,"Organization");
 for(const [discovered,name] of [[await new Gitea("https://gitea.example","fixture").discover(),"Acme"],[await new Gitlab("https://gitlab.example","fixture").repositories(),"Acme/nested"],[await new BitbucketDC("https://bitbucket.example","fixture").repositories(),"Acme"]] as const){
  assert.deepEqual(discovered[0].group,{externalId:"61",name});assert.equal(discovered[1].group,undefined);
 }
});
