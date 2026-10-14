export function nativeConversationCommand(question:string){
 const text=question.trim();
 if(/^@openreview\s+ignore\s+this\s+pattern[.!]?$/i.test(text))return 'ignore-pattern' as const;
 if(/^@openreview\s+(?:re-review|rereview|review\s+again)[.!]?$/i.test(text))return 'rereview' as const;
}
export function nativeCommandAnswer(kind:'ignore-pattern'|'rereview'){
 return kind==='ignore-pattern'?'Saved a repository preference for this finding pattern. Inspect it in Memory → Learned preferences; workspace admins can disable it there. No test execution is claimed.':'Re-review requested. OpenReview will queue the current archived shelf once this acknowledgement is recorded. Inspect its progress in the dashboard. This request does not approve or merge the change, and no test execution is claimed.';
}
