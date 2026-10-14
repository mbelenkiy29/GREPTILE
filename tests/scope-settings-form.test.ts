import test from 'node:test';import assert from 'node:assert/strict';
import {scopeSettingsFromForm} from '../src/scope-settings-form';import {defaults,scopeDefaults} from '../src/review-settings';

test('team form displays inherited values instead of dormant saved overrides',()=>{
 const scopes=[{settings:{...defaults,minimumConfidence:.97,maxComments:3,summarySections:['risk'],mode:'deep'},overrideKeys:['minimumConfidence','maxComments','summarySections','mode']},
  {teamId:'team-a',settings:{...defaults,minimumConfidence:.6,maxComments:1,summarySections:[],mode:'fast'},overrideKeys:['maxComments']}];
 const displayed=scopeDefaults(scopes,'team-a');
 assert.equal(displayed.minimumConfidence,.97);assert.equal(displayed.maxComments,1);assert.equal(displayed.mode,'deep');assert.deepEqual(displayed.summarySections,['risk']);
 const absentTeam=scopeDefaults(scopes,'team-b');assert.equal(absentTeam.minimumConfidence,.97);assert.equal(absentTeam.maxComments,3);
 scopes[1].overrideKeys.push('summarySections');assert.deepEqual(scopeDefaults(scopes,'team-a').summarySections,[]);
 scopes[1].overrideKeys=[];assert.equal(scopeDefaults(scopes,'team-a').maxComments,3);
 assert.equal(scopes[1].settings.minimumConfidence,.6,'display resolution must not rewrite dormant settings');
});

test('scope form retains explicit model/mode/category overrides across other edits',()=>{
 const form=new FormData();for(const [k,v] of Object.entries({maxComments:'2',minimumConfidence:'0.92',mode:'deep',severityThreshold:'high',model:'gpt-4.1',instructions:'Preserve cents.',targetBranches:' main, release/*, ',ignoredPaths:' vendor/**, generated/** ',categoriesConfigured:'true',summaryConfigured:'true',commentStyle:'detailed'}))form.set(k,v);
 form.append('categories','correctness');form.append('categories','rules');form.append('summarySections','risk');form.append('summarySections','score');
 const result=scopeSettingsFromForm(form);
 assert.equal(result.mode,'deep');assert.equal(result.severityThreshold,'high');assert.equal(result.model,'gpt-4.1');assert.deepEqual(result.categories,['correctness','rules']);assert.deepEqual(result.summarySections,['risk','score']);assert.deepEqual(result.targetBranches,['main','release/*']);assert.deepEqual(result.ignoredPaths,['vendor/**','generated/**']);assert.equal(result.maxComments,2);assert.equal(result.minimumConfidence,.92);assert.equal(result.automatic,false);assert.equal(result.commentStyle,'detailed');
});
test('configured empty selections differ from omitted legacy fields',()=>{
 const form=new FormData();form.set('maxComments','10');form.set('minimumConfidence','.85');form.set('automatic','on');
 assert.deepEqual(scopeSettingsFromForm(form).categories,defaults.categories);assert.deepEqual(scopeSettingsFromForm(form).summarySections,defaults.summarySections);assert.equal(scopeSettingsFromForm(form).automatic,true);
 form.set('categoriesConfigured','true');form.set('summaryConfigured','true');
 assert.deepEqual(scopeSettingsFromForm(form).categories,[]);assert.deepEqual(scopeSettingsFromForm(form).summarySections,[]);
 form.set('minimumConfidence','untrusted');assert.equal(Number.isNaN(scopeSettingsFromForm(form).minimumConfidence),true);
});
