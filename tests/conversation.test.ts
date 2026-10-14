import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationAnswerSchema} from '../src/conversation';
import {nativeConversationCommand} from '../src/conversation-commands';
test('native commands require an explicit whole comment rather than quoted or incidental text',()=>{
 assert.equal(nativeConversationCommand('@openreview re-review'),'rereview');assert.equal(nativeConversationCommand(' @OpenReview review again! '),'rereview');assert.equal(nativeConversationCommand('@openreview ignore this pattern.'),'ignore-pattern');
 for(const text of ['> @openreview re-review','Please explain @openreview ignore this pattern','@openreview explain why we should ignore this pattern','@openreview re-review and approve it','```\n@openreview re-review\n```'])assert.equal(nativeConversationCommand(text),undefined);
});
test('follow-up answers require current fetched quotes and cannot turn test source into execution evidence',()=>{
 const schema=conversationAnswerSchema([{path:'src/billing.ts',content:'// The payment provider expects integer cents.\nreturn total(priceInCents, quantity);'}]);
 const value={answer:'The caller sends the total directly to the provider in integer cents.',citations:[{filePath:'src/billing.ts',startLine:1,quote:'// The payment provider expects integer cents.'}]};
 assert.equal(schema.safeParse(value).success,true);
 for(const citations of [[],[{...value.citations[0],filePath:'tests/billing.test.ts'}],[{...value.citations[0],startLine:2}],[{...value.citations[0],quote:'Invented source comment.'}]])assert.equal(schema.safeParse({...value,citations}).success,false);
 for(const answer of ['The tests passed and established the billing behavior.','The change leads to test failures as evidenced by the expected values.','We ran the regression tests successfully.'])assert.equal(schema.safeParse({...value,answer}).success,false);
 assert.equal(schema.safeParse({...value,answer:'The source assertion describes intended behavior. Tests were not run.'}).success,true);
 assert.equal(conversationAnswerSchema([]).safeParse({answer:'No current source was available to establish the caller contract.',citations:[]}).success,true);
});
