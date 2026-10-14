import test from "node:test";
import assert from "node:assert/strict";
import {approvalBlockers,approvalDefaults,approvalPolicySchema,type ApprovalState} from "../src/approval";
import {reviewSummarySchema} from "../src/engine/review";
test("automatic approval requires every trusted gate, maximum confidence, and exact revision evidence",()=>{
 const policy={...approvalDefaults,enabled:true,requiredChecks:[{name:"regression",appId:42}]};
 const state:ApprovalState={supported:true,open:true,draft:false,head:"current",reviewedHead:"current",latest:true,completed:true,coverageLimits:[],unresolved:0,assessment:{risk:"low",confidence:1,reason:"The change only updates a documented display label."},author:"alice",changedPaths:["docs/start.md"],humanChangeRequested:false,requiredChecksKnown:true,checks:[{name:"regression",appId:42,status:"completed",conclusion:"success"}],nativeRequiredChecks:[],runtimeRequired:false,runtimePassed:false};
 assert.deepEqual(approvalBlockers(policy,state),[]);
 assert.ok(approvalBlockers(approvalDefaults,state).length);
 const failures:Partial<ApprovalState>[]=[{supported:false},{open:false},{draft:true},{latest:false},{head:"new"},{revisionKey:"version2"},{completed:false},{coverageLimits:undefined},{coverageLimits:["Excluded source"]},{unresolved:1},{assessment:undefined},{assessment:{...state.assessment!,confidence:.999}},{assessment:{...state.assessment!,risk:"unknown"}},{assessment:{...state.assessment!,risk:"medium"}},{humanChangeRequested:true},{requiredChecksKnown:false},{checks:[]},{checks:[{name:"regression",appId:43,status:"completed",conclusion:"success"}]},{checks:[{name:"regression",appId:42,status:"completed",conclusion:"neutral"}]},{nativeRequiredChecks:[{name:"security"}]},{runtimeRequired:true}];
 for(const failure of failures)assert.ok(approvalBlockers(policy,{...state,...failure}).length,JSON.stringify(failure));
 assert.ok(approvalBlockers({...policy,excludedPaths:["docs/**"]},state).length);
 assert.ok(approvalBlockers({...policy,excludedAuthors:["ALICE"]},state).length);
 assert.deepEqual(approvalBlockers(policy,{...state,runtimeRequired:true,runtimePassed:true}),[]);
 assert.ok(approvalBlockers(policy,{...state,checks:[...state.checks,{name:"regression",appId:42,status:"completed",conclusion:"failure"}]}).length);
 assert.equal(approvalPolicySchema.safeParse({...policy,maximumRisk:"unknown"}).success,false);
 assert.equal(reviewSummarySchema(undefined).safeParse({summary:"The change updates documentation without altering execution.",approvalAssessment:{risk:"low",confidence:1.1,reason:"An invalid confidence must never permit approval."}}).success,false);
 assert.equal(reviewSummarySchema(undefined).parse({summary:"A legacy review has no approval assessment."}).approvalAssessment,undefined);
});
