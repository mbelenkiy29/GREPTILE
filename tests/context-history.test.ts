import test from 'node:test';
import assert from 'node:assert/strict';
import {hasCurrentRepositoryEvidence} from '../src/context-history';
test('previous external evidence cannot enter a new review after its pinned source is omitted or changes revision',()=>{
 const path='context/source/old-sha/contract.ts',finding={evidence:[{filePath:'billing.ts'},{filePath:path}]};
 assert.equal(hasCurrentRepositoryEvidence(finding,[]),false);
 assert.equal(hasCurrentRepositoryEvidence(finding,[{path:'context/source/new-sha/contract.ts',sha:'new-sha',content:'changed contract'}]),false);
 assert.equal(hasCurrentRepositoryEvidence(finding,[{path,sha:'old-sha',content:'current authorized source'}]),true);
 assert.equal(hasCurrentRepositoryEvidence({evidence:[{filePath:'billing.ts'}]},[]),true);
});
